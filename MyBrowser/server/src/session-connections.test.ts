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
});
