import { describe, expect, it } from "vitest";
import { SessionConnectionRegistry } from "./session-connections.js";

describe("SessionConnectionRegistry", () => {
  it("keeps socket and session bindings immutable until unbound", () => {
    const registry = new SessionConnectionRegistry<object>();
    const a = {};
    const b = {};

    expect(registry.bind(a, "s1")).toEqual({ ok: true });
    expect(registry.bind(a, "s2")).toEqual({ ok: false, code: "SESSION_IDENTITY_MISMATCH" });
    expect(registry.bind(b, "s1")).toEqual({ ok: false, code: "SESSION_IDENTITY_MISMATCH" });
    expect(registry.unbind(a)).toBe("s1");
    expect(registry.bind(b, "s1")).toEqual({ ok: true });
  });

  it("reports only currently bound sessions", () => {
    const registry = new SessionConnectionRegistry<object>();
    const socket = {};

    expect(registry.getSession(socket)).toBeUndefined();
    expect(registry.hasLiveSession("s1")).toBe(false);

    registry.bind(socket, "s1");
    expect(registry.getSession(socket)).toBe("s1");
    expect(registry.hasLiveSession("s1")).toBe(true);

    registry.unbind(socket);
    expect(registry.getSession(socket)).toBeUndefined();
    expect(registry.hasLiveSession("s1")).toBe(false);
  });

  it.each(["", "   ", "with:colon", "x".repeat(129)])(
    "rejects an invalid session ID %j without creating a binding",
    (sessionId) => {
    const registry = new SessionConnectionRegistry<object>();
    const socket = {};

    expect(registry.bind(socket, sessionId)).toEqual({
      ok: false,
      code: "INVALID_SESSION_ID",
    });
    expect(registry.getSession(socket)).toBeUndefined();
    expect(registry.hasLiveSession(sessionId)).toBe(false);
    },
  );

  it.each(["a", "x".repeat(128), "550e8400-e29b-41d4-a716-446655440000"])(
    "accepts a valid v2 session ID %j",
    (sessionId) => {
      const registry = new SessionConnectionRegistry<object>();
      expect(registry.bind({}, sessionId)).toEqual({ ok: true });
    },
  );

  it("does not let a stale unbind remove a replacement socket", () => {
    const registry = new SessionConnectionRegistry<object>();
    const oldSocket = {};
    const replacementSocket = {};

    expect(registry.bind(oldSocket, "s1")).toEqual({ ok: true });
    expect(registry.unbind(oldSocket)).toBe("s1");
    expect(registry.bind(replacementSocket, "s1")).toEqual({ ok: true });

    expect(registry.unbind(oldSocket)).toBeUndefined();
    expect(registry.getSession(replacementSocket)).toBe("s1");
    expect(registry.hasLiveSession("s1")).toBe(true);
  });
});
