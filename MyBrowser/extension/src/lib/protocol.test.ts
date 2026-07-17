import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  isAuthResultV2,
  isExtensionTraceSummaryV1,
  isTraceContextV1,
  isToolRequestV2,
  isToolResponseV2,
} from "./protocol";

describe("protocol v2", () => {
  const trace = {
    schemaVersion: 1 as const,
    traceId: "trace_1234567890abcdef",
    rootCallId: "root_1234567890abcdefg",
    transportSpanId: "span_1234567890abcdefg",
  };

  it("exports protocol version 2", () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });

  it("accepts a versioned auth result", () => {
    expect(
      isAuthResultV2({
        type: "auth",
        status: "ok",
        protocolVersion: 2,
        browserId: "browser-a",
      }),
    ).toBe(true);
  });

  it("rejects an auth result with no version", () => {
    expect(
      isAuthResultV2({
        type: "auth",
        status: "ok",
        browserId: "browser-a",
      }),
    ).toBe(false);
  });

  it("accepts the v2 tool envelope", () => {
    expect(
      isToolRequestV2({
        id: "req-1",
        type: "browser_click",
        payload: { tabId: 7 },
        sessionId: "session-a",
        timeoutMs: 30_000,
      }),
    ).toBe(true);
  });

  it("rejects malformed tool envelopes", () => {
    const request = {
      id: "req-1",
      type: "browser_click",
      payload: { tabId: 7 },
      sessionId: "session-a",
      timeoutMs: 30_000,
    };

    expect(isToolRequestV2({ ...request, sessionId: undefined })).toBe(false);
    expect(isToolRequestV2({ ...request, payload: null })).toBe(false);
    expect(isToolRequestV2({ ...request, timeoutMs: Number.POSITIVE_INFINITY })).toBe(false);
  });

  it("validates strict optional trace metadata", () => {
    expect(isTraceContextV1(trace)).toBe(true);
    expect(isToolRequestV2({
      id: "req-1", type: "browser_click", payload: {}, sessionId: "session-a",
      timeoutMs: 30_000, trace,
    })).toBe(true);
    for (const invalid of [
      { ...trace, schemaVersion: 2 },
      { ...trace, traceId: "short" },
      { ...trace, transportSpanId: `${trace.transportSpanId}!` },
      { ...trace, extra: true },
    ]) expect(isTraceContextV1(invalid)).toBe(false);
  });

  it("validates bounded content-free extension summaries", () => {
    const summary = {
      schemaVersion: 1 as const,
      traceId: trace.traceId,
      transportSpanId: trace.transportSpanId,
      extensionRequestId: "hub_1",
      offscreenReceivedToBackgroundMs: 1,
      queueWaitMs: 2,
      handlerMs: 3,
      responseSerializeMs: 4,
      resolvedTabId: 7,
      stateSignals: { tabChanged: true },
      errorCategory: "extension_tool_failed",
    };
    expect(isExtensionTraceSummaryV1(summary)).toBe(true);
    expect(isToolResponseV2({
      type: "messageResponse", payload: { requestId: "req-1", telemetry: summary },
    })).toBe(true);
    for (const invalid of [
      { ...summary, queueWaitMs: -1 },
      { ...summary, handlerMs: Number.NaN },
      { ...summary, resolvedTabId: 1.5 },
      { ...summary, stateSignals: { tabChanged: true, rawUrl: "secret" } },
      { ...summary, errorCategory: "raw error" },
      { ...summary, resultContent: "secret" },
    ]) expect(isExtensionTraceSummaryV1(invalid)).toBe(false);
  });
});
