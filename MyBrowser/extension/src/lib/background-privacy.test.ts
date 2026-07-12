import { describe, expect, it, vi } from "vitest";

import { getRecentExtensionIssues } from "./diagnostics";
import { parseInboundWsFrame } from "./background-privacy";

const SECRET_MALFORMED_FRAME = "SECRET_MALFORMED_FRAME_6408";

describe("background privacy boundaries", () => {
  it("logs malformed inbound JSON using only a stable category and byte length", () => {
    const issueCount = getRecentExtensionIssues(100).length;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const raw = `{"payload":"${SECRET_MALFORMED_FRAME}`;

    expect(parseInboundWsFrame(raw)).toEqual({ ok: false });
    const evidence = {
      diagnostics: getRecentExtensionIssues(100).slice(issueCount),
      console: warn.mock.calls,
    };
    warn.mockRestore();

    expect(JSON.stringify(evidence)).not.toContain(SECRET_MALFORMED_FRAME);
    expect(evidence.diagnostics).toEqual([expect.objectContaining({
      area: "ws_message",
      message: "INVALID_JSON",
      details: { byteLength: new TextEncoder().encode(raw).byteLength },
    })]);
  });
});
