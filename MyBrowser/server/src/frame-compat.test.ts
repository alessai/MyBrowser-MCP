import { afterEach, describe, expect, it, vi } from "vitest";
import { Context, unwrapFrameResult, withOldExtensionHint } from "./context.js";

type Core = (ws: unknown, target: unknown, type: string, payload: Record<string, unknown>) => Promise<unknown>;

function contextWith(core: Core) {
  const context = new Context();
  const internals = context as unknown as { getTarget: () => Promise<unknown>; sendSocketMessageCore: Core };
  vi.spyOn(internals, "getTarget").mockResolvedValue({ ws: {}, targetBrowserId: "b1", telemetryBrowserId: "b1" });
  const spy = vi.spyOn(internals, "sendSocketMessageCore").mockImplementation(core);
  return { context, spy };
}

afterEach(() => vi.restoreAllMocks());

describe("frame support with older extensions", () => {
  it("unwraps a 2.1 frame result and leaves other results alone", () => {
    expect(unwrapFrameResult("browser_eval", { frame: "x" }, { mbFrame: "https://x/", value: 7 })).toBe(7);
    // Tools that return nothing arrive without `value` after JSON.
    expect(unwrapFrameResult("browser_click", { frame: "x" }, { mbFrame: "https://x/" })).toBeUndefined();
    expect(unwrapFrameResult("browser_eval", {}, { value: 1 })).toEqual({ value: 1 });
    expect(() => unwrapFrameResult("browser_click", { frame: "x" }, "Clicked")).toThrow(/EXTENSION_TOO_OLD/);
  });

  it("refuses before acting when the extension ignores frame", async () => {
    const { context, spy } = contextWith(async (_ws, _t, type) => (type === "browser_snapshot" ? { snapshot: "page" } : "Clicked"));
    await expect(context.sendSocketMessage("browser_click", { frame: "pay.example", name: "Pay", tabId: 3 }))
      .rejects.toThrow(/EXTENSION_TOO_OLD.*nothing was done/);
    expect(spy.mock.calls.map((c) => c[2])).toEqual(["browser_snapshot"]);
  });

  it("probes once per browser when the extension supports frame", async () => {
    const { context, spy } = contextWith(async (_ws, _t, type) => {
      if (type === "browser_snapshot") throw new Error("FRAME_NOT_FOUND: no frame");
      return { mbFrame: "https://pay.example/", value: "Clicked" };
    });
    await expect(context.sendSocketMessage("browser_click", { frame: "pay.example", tabId: 3 })).resolves.toBe("Clicked");
    await expect(context.sendSocketMessage("browser_click", { frame: "pay.example", tabId: 3 })).resolves.toBe("Clicked");
    expect(spy.mock.calls.map((c) => c[2])).toEqual(["browser_snapshot", "browser_click", "browser_click"]);
  });

  it("explains an unknown tool as an old extension", () => {
    const error = withOldExtensionHint(new Error("Unknown tool: browser_mouse")) as Error;
    expect(error.message).toMatch(/^Unknown tool: browser_mouse\. Update this browser's MyBrowser extension to \d+\.\d+\.\d+/);
    const other = new Error("TAB_CLOSED");
    expect(withOldExtensionHint(other)).toBe(other);
  });
});
