import { describe, expect, it, vi } from "vitest";
import { SessionIncarnation } from "./session-incarnation.js";
import type { IStateManager } from "./state-manager.js";

function stateWithRegister(registerSession: ReturnType<typeof vi.fn>): IStateManager {
  return { registerSession } as unknown as IStateManager;
}

describe("SessionIncarnation", () => {
  it("keeps the same ID when reconnect registration succeeds within grace", async () => {
    const registerSession = vi.fn().mockResolvedValue(undefined);
    const incarnation = new SessionIncarnation("session-a");

    await expect(incarnation.register(stateWithRegister(registerSession), "agent"))
      .resolves.toEqual({ rotated: false, sessionId: "session-a" });
    expect(incarnation.sessionId).toBe("session-a");
    expect(registerSession).toHaveBeenCalledOnce();
  });

  it("rotates to a fresh secure UUID and retries after SESSION_FINALIZED", async () => {
    const registerSession = vi.fn()
      .mockRejectedValueOnce(new Error("SESSION_FINALIZED"))
      .mockResolvedValueOnce(undefined);
    const incarnation = new SessionIncarnation("session-a");

    const result = await incarnation.register(stateWithRegister(registerSession), "agent");

    expect(result).toEqual({ rotated: true, sessionId: incarnation.sessionId });
    expect(incarnation.sessionId).not.toBe("session-a");
    expect(incarnation.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(registerSession).toHaveBeenNthCalledWith(1, "session-a", "agent");
    expect(registerSession).toHaveBeenNthCalledWith(2, incarnation.sessionId, "agent");
  });

  it("does not rotate for unrelated registration failures", async () => {
    const registerSession = vi.fn().mockRejectedValue(new Error("connection lost"));
    const incarnation = new SessionIncarnation("session-a");

    await expect(incarnation.register(stateWithRegister(registerSession)))
      .rejects.toThrow("connection lost");
    expect(incarnation.sessionId).toBe("session-a");
    expect(registerSession).toHaveBeenCalledOnce();
  });
});
