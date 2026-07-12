import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  isAuthResultV2,
  isToolRequestV2,
} from "./protocol";

describe("protocol v2", () => {
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
});
