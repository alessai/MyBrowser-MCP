import { describe, expect, it, vi } from "vitest";

import { getRecentExtensionIssues } from "./diagnostics";
import { parseInboundWsFrame } from "./background-privacy";
import {
  attachExtensionTelemetry,
  createExtensionTelemetrySummaryBuilder,
  telemetryErrorCategory,
} from "./telemetry-summary";

const SECRET_MALFORMED_FRAME = "SECRET_MALFORMED_FRAME_6408";

describe("background privacy boundaries", () => {
  it("keeps argument, result, and error canaries outside extension telemetry", () => {
    const canaries = {
      typedText: "RAW_TYPED_CANARY", form: "RAW_FORM_CANARY",
      clipboard: "RAW_CLIPBOARD_CANARY", storage: "RAW_STORAGE_CANARY",
      eval: "RAW_EVAL_CANARY", result: "RAW_RESULT_CANARY", error: "RAW_ERROR_CANARY",
    };
    const builder = createExtensionTelemetrySummaryBuilder({
      trace: {
        schemaVersion: 1,
        traceId: "trace_1234567890abcdef",
        rootCallId: "root_1234567890abcdefg",
        transportSpanId: "span_1234567890abcdefg",
      },
      extensionRequestId: "hub_1",
      timeoutMs: 1_000,
      backgroundReceivedAtEpochMs: 1_000,
      monotonicNow: () => 0,
    })!;
    const payload = attachExtensionTelemetry({ requestId: "hub_1", result: canaries }, builder);
    const errorPayload = attachExtensionTelemetry(
      { requestId: "hub_1", error: canaries.error }, builder,
      telemetryErrorCategory(new Error(canaries.error)),
    );
    const evidence = JSON.stringify({ success: payload.telemetry, failure: errorPayload.telemetry });
    for (const canary of Object.values(canaries)) expect(evidence).not.toContain(canary);
  });

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
