import type { Context } from "../context.js";
import { guardNote } from "./guard.js";

const MAX_SNAPSHOT_CHARS = 30_000;

/** Optional `frame` for tools that can work inside an embedded frame. */
export const FRAME_DESCRIPTION = "Work inside an embedded frame instead of the page: part of the frame's URL (e.g. \"officeapps.live.com\"). "
  + "An unknown value lists the page's frames. Refs from a frame's snapshot only work with the same frame.";

export async function captureAriaSnapshot(
  context: Context,
  status = "",
  tabId?: number,
  options?: { viewportOnly?: boolean; mode?: "full" | "diff" | "auto"; frame?: string },
) {
  const payload: Record<string, unknown> = {};
  if (tabId !== undefined) payload.tabId = tabId;
  if (options?.viewportOnly !== undefined) payload.viewportOnly = options.viewportOnly;
  if (options?.mode !== undefined) payload.mode = options.mode;

  const url = await context.sendSocketMessage("getUrl", payload);
  const title = await context.sendSocketMessage("getTitle", payload);
  const snapshotPayload = { ...payload };
  if (options?.frame) snapshotPayload.frame = options.frame;
  if (options?.viewportOnly === undefined) snapshotPayload.viewportOnly = true; // default viewport-only
  if (options?.mode === undefined) snapshotPayload.mode = "auto"; // default auto-diff
  let snapshot = (await context.sendSocketMessage("browser_snapshot", snapshotPayload)) as string;

  // Truncate if too large
  if (snapshot && snapshot.length > MAX_SNAPSHOT_CHARS) {
    const lines = snapshot.split("\n");
    let chars = 0;
    let cutLine = lines.length;
    for (let i = 0; i < lines.length; i++) {
      chars += lines[i]!.length + 1;
      if (chars > MAX_SNAPSHOT_CHARS) {
        cutLine = i;
        break;
      }
    }
    const isViewport = snapshotPayload.viewportOnly;
    const hint = isViewport
      ? 'Try browser_screenshot with annotations for a more compact view.'
      : 'Use viewportOnly:true for a compact view or browser_screenshot with annotations.';
    snapshot = lines.slice(0, cutLine).join("\n") +
      `\n... (truncated at ${MAX_SNAPSHOT_CHARS} chars. ${hint})`;
  }

  const warning = guardNote(`${title}\n${snapshot ?? ""}`);
  return {
    content: [
      {
        type: "text" as const,
        text: `${status ? `${status}\n` : ""}${warning ? `${warning}\n` : ""}\n- Page URL: ${url}\n- Page Title: ${title}\n${options?.frame ? `- Frame: ${options.frame}\n` : ""}- Page Snapshot\n\`\`\`yaml\n${snapshot}\n\`\`\`\n`,
      },
    ],
  };
}
