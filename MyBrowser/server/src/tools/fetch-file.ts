import { randomUUID } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "./types.js";

const FETCH_TRANSFER_TIMEOUT_MS = 300_000;

const FetchFileArgs = z.object({
  url: z.string().url().describe("URL to fetch. The request runs through the selected browser, so its cookies, session, and network position apply. Loopback hostnames are rewritten to the canonical device host when one is configured."),
  filename: z.string().optional().describe("Filename for the transferred file (sanitized to [A-Za-z0-9._-]). If omitted, uses the last URL path segment."),
});

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

export const fetchFile: Tool = {
  schema: {
    name: "browser_fetch_file",
    description: "Fetch a URL THROUGH the selected browser (its cookies, session, and network position apply) and transfer the bytes to the MCP server machine. The file lands under ~/.mybrowser/transfers/downloads/<sessionId>/ on the MCP server machine together with a .provenance.json sidecar; it is NOT saved in the browser's downloads folder — for browser-local landing use browser_download. Transfers are chunked and sha256-verified; the tool may take up to 5 minutes for larger files. Loopback hostnames are rewritten to the canonical device host when one is configured.",
    inputSchema: zodToJsonSchema(FetchFileArgs),
  },
  handle: async (context, params) => {
    const { url, filename } = FetchFileArgs.parse(params);
    const transferId = randomUUID();
    const resolvedFilename = sanitizeFilename(filename ?? deriveFilename(url));
    const result = await context.sendSocketMessage(
      "browser_fetch_file",
      { url, filename: resolvedFilename, transferId },
      { timeoutMs: FETCH_TRANSFER_TIMEOUT_MS },
    );
    // The hub resolves with the full `bytes` payload; the file is already on
    // disk (landedPath), so the text content carries the summary only.
    const summary = typeof result === "object" && result !== null ? { ...result, bytes: undefined } : result;
    const text = typeof summary === "string" ? summary : JSON.stringify(summary, null, 2);
    return {
      content: [{ type: "text" as const, text }],
    };
  },
};
