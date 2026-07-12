import { describe, expect, it } from "vitest";

import * as serverProtocol from "./protocol.js";

const extensionProtocolPath = "../../extension/src/lib/protocol.js";
const extensionProtocol = await import(extensionProtocolPath);

describe("protocol v2 conformance", () => {
  it("uses protocol version 2 in both packages", () => {
    expect(serverProtocol.PROTOCOL_VERSION).toBe(2);
    expect(extensionProtocol.PROTOCOL_VERSION).toBe(2);
  });

  it("accepts a versioned auth result in both packages", () => {
    const authResult = {
      type: "auth",
      status: "ok",
      protocolVersion: 2,
      browserId: "browser-a",
    };

    expect(serverProtocol.isAuthResultV2(authResult)).toBe(true);
    expect(extensionProtocol.isAuthResultV2(authResult)).toBe(true);
  });

  it("rejects an auth result with no version in both packages", () => {
    const authResult = {
      type: "auth",
      status: "ok",
      browserId: "browser-a",
    };

    expect(serverProtocol.isAuthResultV2(authResult)).toBe(false);
    expect(extensionProtocol.isAuthResultV2(authResult)).toBe(false);
  });

  it("accepts the v2 tool envelope in both packages", () => {
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
});
