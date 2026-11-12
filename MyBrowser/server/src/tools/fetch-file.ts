import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { defaultTransfersRoot } from "../transfers/retention.js";
import { z } from "zod";
import { zodToJsonSchema } from "../utils/json-schema.js";
import type { Context } from "../context.js";
import type { Tool } from "./types.js";

const FETCH_TRANSFER_TIMEOUT_MS = 300_000;
// The hub runs at most 2 transfers per session at a time.
const CONCURRENCY = 2;
const MAX_URLS = 50;
const INLINE_MAX_BYTES = 256 * 1024;
// All inlined bodies of one urls call together, so a batch cannot flood the agent's context.
const INLINE_TOTAL_MAX_BYTES = 512 * 1024;
const TEXTUAL = /^(text\/|application\/(json|xml|javascript|ld\+json|x-ndjson|csv)|[^;]*\+(json|xml))/i;

const FetchFileArgs = z.object({
  url: z.string().url().optional().describe("URL to fetch. The request runs through the selected browser, so its cookies, session, and network position apply. Loopback hostnames are rewritten to the canonical device host when one is configured."),
  urls: z.array(z.string().url()).max(MAX_URLS).optional().describe(`Several URLs in one call (up to ${MAX_URLS}, ${CONCURRENCY} at a time); one result line per URL. Use instead of one call per file.`),
  filename: z.string().optional().describe("Filename for the transferred file (sanitized to [A-Za-z0-9._-]). If omitted, uses the last URL path segment. Ignored with urls."),
  inline: z.boolean().optional().describe(`Also return the response body as text (JSON, HTML, CSV..., up to ${INLINE_MAX_BYTES / 1024} KB), so there is no file to read afterwards. Use for API/JSON calls.`),
}).refine((a) => (a.url === undefined) !== (a.urls === undefined), { message: "give url or urls (not both)" });

function deriveFilename(url: string): string {
  try {
    const name = new URL(url).pathname.split("/").filter(Boolean).at(-1);
    return name ? decodeURIComponent(name) : "download";
  } catch {
    return "download";
  }
}

function sanitizeFilename(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+/, "").slice(0, 120);
  if (cleaned.length === 0) return "download";
  if (!/^[A-Za-z0-9]/.test(cleaned)) return `download-${cleaned}`.slice(0, 120);
  return cleaned;
}

type Landed = { landedPath?: string; filename?: string; sha256?: string; mimeType?: string; bytes?: unknown };

async function fetchOne(context: Context, url: string, filename: string | undefined): Promise<Landed> {
  const result = await context.sendSocketMessage(
    "browser_fetch_file",
    { url, filename: sanitizeFilename(filename ?? deriveFilename(url)), transferId: randomUUID() },
    { timeoutMs: FETCH_TRANSFER_TIMEOUT_MS },
  );
  // The hub resolves with the byte count too; the file is already on disk (landedPath).
  return typeof result === "object" && result !== null ? { ...(result as Landed), bytes: undefined } : (result as Landed);
}

/**
 * The landed file as text when it is small and textual. Only files under the
 * transfers downloads folder are read (defense in depth: the path comes from the hub).
 */
async function inlineBody(landed: Landed, budget: { left: number } = { left: INLINE_MAX_BYTES }): Promise<string> {
  if (!landed.landedPath) return "(no file landed)";
  try {
    const root = await realpath(join(defaultTransfersRoot(), "downloads"));
    const path = await realpath(landed.landedPath);
    if (!path.startsWith(root + sep)) return `(body not inlined: ${landed.landedPath} is outside the transfers folder)`;
    const { size } = await stat(path);
    if (size > INLINE_MAX_BYTES) return `(body not inlined: ${size} bytes is over ${INLINE_MAX_BYTES / 1024} KB; read ${landed.landedPath})`;
    if (size > budget.left) return `(body not inlined: this call already returned ${INLINE_TOTAL_MAX_BYTES / 1024} KB; read ${landed.landedPath})`;
    budget.left -= size;
    const buffer = await readFile(path);
    const text = buffer.toString("utf8");
    if (!TEXTUAL.test(landed.mimeType ?? "") && /\uFFFD/.test(text)) return `(body not inlined: ${landed.mimeType ?? "binary"} content)`;
    return text;
  } catch {
    return `(body not inlined: the file is on the hub machine, not readable here: ${landed.landedPath})`;
  }
}

export const fetchFile: Tool = {
  schema: {
    name: "browser_fetch_file",
    description: "Fetch a URL THROUGH the selected browser (its cookies, session, and network position apply) and transfer the bytes to the MCP server machine. "
      + "The file lands under ~/.mybrowser/transfers/downloads/<sessionId>/ on the MCP server machine together with a .provenance.json sidecar; it is NOT saved in the browser's downloads folder — for browser-local landing use browser_download. "
      + `inline:true also returns the body as text (up to ${INLINE_MAX_BYTES / 1024} KB), e.g. for JSON APIs: {url, inline: true}. urls fetches several in one call. `
      + "Transfers are chunked and sha256-verified; the tool may take up to 5 minutes for larger files. Loopback hostnames are rewritten to the canonical device host when one is configured.",
    inputSchema: zodToJsonSchema(FetchFileArgs),
  },
  handle: async (context, params) => {
    const { url, urls, filename, inline } = FetchFileArgs.parse(params);
    if (url !== undefined) {
      const landed = await fetchOne(context, url, filename);
      const text = typeof landed === "string" ? landed : JSON.stringify(landed, null, 2);
      return { content: [{ type: "text" as const, text: inline ? `${text}\n\nBody:\n${await inlineBody(landed)}` : text }] };
    }
    const list = urls!;
    const lines: string[] = new Array(list.length);
    const budget = { left: INLINE_TOTAL_MAX_BYTES };
    let next = 0;
    let failed = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, async () => {
      while (next < list.length) {
        const i = next++;
        try {
          // Numbered names: two URLs ending in the same name must not land on one file.
          const landed = await fetchOne(context, list[i]!, `${i + 1}-${deriveFilename(list[i]!)}`);
          lines[i] = `${i + 1}. OK ${list[i]} -> ${landed.landedPath} (${landed.mimeType ?? "?"}, sha256 ${String(landed.sha256 ?? "").slice(0, 12)})`
            + (inline ? `\n${await inlineBody(landed, budget)}` : "");
        } catch (error) {
          failed += 1;
          lines[i] = `${i + 1}. FAILED ${list[i]}: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }));
    return {
      content: [{ type: "text" as const, text: `Fetched ${list.length - failed} of ${list.length} URLs.\n${lines.join("\n")}` }],
      ...(failed === list.length ? { isError: true } : {}),
    };
  },
};
