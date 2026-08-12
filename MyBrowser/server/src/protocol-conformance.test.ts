import { describe, expect, it } from "vitest";

import * as serverProtocol from "./protocol.js";

const extensionProtocolPath = "../../extension/src/lib/protocol.js";
const extensionProtocol = await import(extensionProtocolPath);

describe("protocol v2 conformance", () => {
  it("matches protocol version across both packages", () => {
    expect(serverProtocol.PROTOCOL_VERSION).toBe(2);
    expect(extensionProtocol.PROTOCOL_VERSION).toBe(serverProtocol.PROTOCOL_VERSION);
  });

  it("matches WebSocket close codes across both packages", () => {
    expect(serverProtocol.WS_CLOSE).toEqual({
      unauthorized: 4001,
      invalidJson: 4003,
      forbiddenRole: 4403,
      versionMismatch: 4406,
    });
    expect(extensionProtocol.WS_CLOSE).toEqual(serverProtocol.WS_CLOSE);
  });

  it("matches connection roles across both packages", () => {
    expect(serverProtocol.CONNECTION_ROLES).toEqual(["client", "extension"]);
    expect(extensionProtocol.CONNECTION_ROLES).toEqual(serverProtocol.CONNECTION_ROLES);
  });

  it("matches protocol error codes across both packages", () => {
    expect(serverProtocol.PROTOCOL_ERROR_CODES).toEqual([
      "PROTOCOL_VERSION_MISMATCH",
      "AUTH_ROLE_VIOLATION",
      "SESSION_NOT_REGISTERED",
      "SESSION_CLOSED",
      "SESSION_FINALIZED",
      "SESSION_IDENTITY_MISMATCH",
      "SERVER_SHUTTING_DOWN",
      "INVALID_SESSION_ID",
      "REQUEST_EXPIRED",
      "QUEUE_OVERLOADED",
      "TAB_CLOSED",
      "RECORDING_NOT_OWNED",
      "RECORDING_NAME_CONFLICT",
      "RECORDING_RESERVATION_EXPIRED",
      "RECORDING_STATE_LIMIT",
      "RECORDING_UNSUPPORTED_MULTI_TAB",
      "REPLAY_VARIABLES_MISSING",
      "RECORDING_PERSISTENCE_PARTIAL",
      "EXTENSION_WORKER_RESTARTED",
    ]);
    expect(extensionProtocol.PROTOCOL_ERROR_CODES).toEqual(
      serverProtocol.PROTOCOL_ERROR_CODES,
    );
  });

  it("accepts a v2 auth request in both packages", () => {
    const request = {
      type: "auth",
      token: "token-a",
      role: "extension",
      protocolVersion: 2,
      browserName: "browser-a",
    };

    expect(serverProtocol.isAuthRequestV2(request)).toBe(true);
    expect(extensionProtocol.isAuthRequestV2(request)).toBe(true);
  });

  it("keeps bounded auth reconciliation guards equivalent across packages", () => {
    const request = {
      type: "auth", token: "token-a", role: "extension", protocolVersion: 2,
      browserName: "browser-a", temporaryTabSessionIds: ["session-a", "session_b"],
    };
    const result = {
      type: "auth", status: "ok", protocolVersion: 2,
      browserId: "browser-a", finalizedSessionIds: ["session-a"],
    };
    expect(serverProtocol.isAuthRequestV2(request)).toBe(true);
    expect(extensionProtocol.isAuthRequestV2(request)).toBe(true);
    expect(serverProtocol.isAuthResultV2(result)).toBe(true);
    expect(extensionProtocol.isAuthResultV2(result)).toBe(true);

    for (const invalid of [
      { ...request, role: "client" },
      { ...request, temporaryTabSessionIds: ["same", "same"] },
      { ...request, temporaryTabSessionIds: ["bad session"] },
      { ...request, temporaryTabSessionIds: Array.from({ length: 65 }, (_, index) => `s${index}`) },
      { ...request, extra: true },
    ]) {
      expect(serverProtocol.isAuthRequestV2(invalid)).toBe(false);
      expect(extensionProtocol.isAuthRequestV2(invalid)).toBe(false);
    }
    for (const invalid of [
      { ...result, finalizedSessionIds: ["same", "same"] },
      { ...result, finalizedSessionIds: ["bad session"] },
      { ...result, finalizedSessionIds: Array.from({ length: 65 }, (_, index) => `s${index}`) },
      { ...result, extra: true },
    ]) {
      expect(serverProtocol.isAuthResultV2(invalid)).toBe(false);
      expect(extensionProtocol.isAuthResultV2(invalid)).toBe(false);
    }
  });

  it("rejects invalid auth requests in both packages", () => {
    const request = {
      type: "auth",
      token: "token-a",
      role: "extension",
      protocolVersion: 2,
    };

    for (const invalidRequest of [
      { ...request, role: "admin" },
      { ...request, protocolVersion: 1 },
      { ...request, token: undefined },
    ]) {
      expect(serverProtocol.isAuthRequestV2(invalidRequest)).toBe(false);
      expect(extensionProtocol.isAuthRequestV2(invalidRequest)).toBe(false);
    }
  });

  it("accepts a versioned auth result in both packages", () => {
    const result = {
      type: "auth",
      status: "ok",
      protocolVersion: 2,
      browserId: "browser-a",
    };

    expect(serverProtocol.isAuthResultV2(result)).toBe(true);
    expect(extensionProtocol.isAuthResultV2(result)).toBe(true);
  });

  it("rejects invalid auth results in both packages", () => {
    const result = {
      type: "auth",
      status: "ok",
      protocolVersion: 2,
      browserId: "browser-a",
    };

    for (const invalidResult of [
      { ...result, protocolVersion: undefined },
      { ...result, protocolVersion: 1 },
      { ...result, browserId: 7 },
    ]) {
      expect(serverProtocol.isAuthResultV2(invalidResult)).toBe(false);
      expect(extensionProtocol.isAuthResultV2(invalidResult)).toBe(false);
    }
  });

  it("accepts a v2 tool request in both packages", () => {
    const request = {
      id: "req-1",
      type: "browser_click",
      payload: { tabId: 7 },
      sessionId: "session-a",
      timeoutMs: 30_000,
    };

    expect(serverProtocol.isToolRequestV2(request)).toBe(true);
    expect(extensionProtocol.isToolRequestV2(request)).toBe(true);
  });

  it("validates bounded schema-v1 trace contexts on the server", () => {
    const traceId = "trace_1234567890abcdef";
    const trace = {
      schemaVersion: 1,
      traceId,
      rootCallId: "root_1234567890abcdef",
      transportSpanId: "span_1234567890abcdef",
    };

    expect(serverProtocol.isTraceContextV1(trace)).toBe(true);
    for (const invalidTrace of [
      { ...trace, schemaVersion: 2 },
      { ...trace, traceId: "short" },
      { ...trace, traceId: `${traceId}!` },
      { ...trace, traceId: "x".repeat(65) },
      { ...trace, transportSpanId: "short" },
      { ...trace, extra: true },
    ]) {
      expect(serverProtocol.isTraceContextV1(invalidTrace)).toBe(false);
    }
    const hostile = { ...trace };
    Object.defineProperty(hostile, "traceId", { get: () => { throw new Error("getter invoked"); } });
    expect(() => serverProtocol.isTraceContextV1(hostile)).not.toThrow();
    expect(serverProtocol.isTraceContextV1(hostile)).toBe(false);
  });

  it("accepts only valid optional trace metadata in a v2 tool request", () => {
    const traceId = "trace_1234567890abcdef";
    const request = {
      id: "req-1",
      type: "browser_click",
      payload: { tabId: 7 },
      sessionId: "session-a",
      timeoutMs: 30_000,
      trace: {
        schemaVersion: 1,
        traceId,
        rootCallId: "root_1234567890abcdef",
        transportSpanId: "span_1234567890abcdef",
      },
    };

    expect(serverProtocol.isToolRequestV2(request)).toBe(true);
    expect(serverProtocol.isToolRequestV2({
      ...request,
      trace: { ...request.trace, transportSpanId: "short" },
    })).toBe(false);
  });

  it("keeps extension trace-summary guards equivalent across packages", () => {
    const summary = {
      schemaVersion: 1 as const,
      traceId: "trace_1234567890abcdef",
      transportSpanId: "span_1234567890abcdefg",
      extensionRequestId: "hub_1",
      offscreenReceivedToBackgroundMs: 1,
      queueWaitMs: 2,
      handlerMs: 3,
      responseSerializeMs: 4,
      resolvedTabId: 7,
      stateSignals: { tabChanged: true },
      errorCategory: "extension_tool_failed",
    };
    expect(serverProtocol.isExtensionTraceSummaryV1(summary)).toBe(true);
    expect(extensionProtocol.isExtensionTraceSummaryV1(summary)).toBe(true);
    for (const invalid of [
      { ...summary, queueWaitMs: -1 },
      { ...summary, stateSignals: { tabChanged: true, rawUrl: "secret" } },
      { ...summary, errorCategory: "raw error" },
      { ...summary, resultContent: "secret" },
    ]) {
      expect(serverProtocol.isExtensionTraceSummaryV1(invalid)).toBe(false);
      expect(extensionProtocol.isExtensionTraceSummaryV1(invalid)).toBe(false);
    }
  });

  it("rejects invalid tool requests in both packages", () => {
    const request = {
      id: "req-1",
      type: "browser_click",
      payload: { tabId: 7 },
      sessionId: "session-a",
      timeoutMs: 30_000,
    };

    for (const invalidRequest of [
      { ...request, payload: null },
      { ...request, sessionId: undefined },
      { ...request, timeoutMs: Number.POSITIVE_INFINITY },
    ]) {
      expect(serverProtocol.isToolRequestV2(invalidRequest)).toBe(false);
      expect(extensionProtocol.isToolRequestV2(invalidRequest)).toBe(false);
    }
  });

  it("accepts a v2 tool response in both packages", () => {
    const response = {
      type: "messageResponse",
      payload: {
        requestId: "req-1",
        result: { clicked: true },
      },
    };

    expect(serverProtocol.isToolResponseV2(response)).toBe(true);
    expect(extensionProtocol.isToolResponseV2(response)).toBe(true);
  });

  it("rejects invalid tool responses in both packages", () => {
    const response = {
      type: "messageResponse",
      payload: {
        requestId: "req-1",
        error: "TAB_CLOSED",
      },
    };

    for (const invalidResponse of [
      { ...response, type: "response" },
      { ...response, payload: null },
      { ...response, payload: { requestId: 7 } },
      { ...response, payload: { requestId: "req-1", error: 7 } },
    ]) {
      expect(serverProtocol.isToolResponseV2(invalidResponse)).toBe(false);
      expect(extensionProtocol.isToolResponseV2(invalidResponse)).toBe(false);
    }
  });
});
