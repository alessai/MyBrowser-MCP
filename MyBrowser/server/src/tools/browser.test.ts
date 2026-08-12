import { describe, expect, it, vi } from "vitest";

import type { Context } from "../context.js";
import type { IStateManager } from "../state-manager.js";
import { createBrowserTools } from "./browser.js";

function createState() {
  return {
    clearSessionBrowser: vi.fn().mockResolvedValue(true),
    getDefaultBrowser: vi.fn().mockResolvedValue({
      defaultBrowserName: "ChromeUbunut",
      status: "connected",
      resolvedBrowserId: "ubuntu",
      resolvedBrowserName: "ChromeUbunut",
    }),
    getSessionBrowser: vi.fn().mockResolvedValue(undefined),
    listBrowsers: vi.fn().mockResolvedValue([
      { id: "ubuntu", name: "ChromeUbunut", connectedAt: 1 },
      { id: "windows", name: "Mainpc", connectedAt: 1 },
    ]),
    resolveBrowserTarget: vi.fn().mockResolvedValue({
      ok: true,
      browserId: "ubuntu",
      browserName: "ChromeUbunut",
      source: "default",
    }),
    selectBrowser: vi.fn().mockResolvedValue(undefined),
    setDefaultBrowser: vi.fn().mockResolvedValue({
      defaultBrowserName: "ChromeUbunut",
      status: "connected",
      resolvedBrowserId: "ubuntu",
      resolvedBrowserName: "ChromeUbunut",
    }),
  } as unknown as IStateManager;
}

const context = { isClientMode: true } as Context;

describe("browser routing tools", () => {
  it("clears the current session override and reports the effective default", async () => {
    const state = createState();
    const { useDefaultBrowser } = createBrowserTools(state, () => "session-a");

    const result = await useDefaultBrowser.handle(context, {});

    expect(state.clearSessionBrowser).toHaveBeenCalledWith("session-a");
    expect(state.resolveBrowserTarget).toHaveBeenCalledWith("session-a");
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("ChromeUbunut"),
    });
  });

  it("clears only the caller override after changing the shared default", async () => {
    const state = createState();
    const { setDefaultBrowser } = createBrowserTools(state, () => "session-a");

    await setDefaultBrowser.handle(context, { browserId: "ubuntu" });

    expect(state.setDefaultBrowser).toHaveBeenCalledWith("ubuntu");
    expect(state.clearSessionBrowser).toHaveBeenCalledWith("session-a");
  });

  it("documents explicit overrides, expiry, and reset paths", () => {
    const { selectBrowser, useDefaultBrowser } = createBrowserTools(createState(), () => "session-a");

    expect(selectBrowser.schema.description).toContain("explicitly asked");
    expect(selectBrowser.schema.description).toContain("30 minutes");
    expect(selectBrowser.schema.description).toContain("use_default_browser");
    expect(useDefaultBrowser.schema.name).toBe("use_default_browser");
  });

  it("reports how to return after selecting an override", async () => {
    const { selectBrowser } = createBrowserTools(createState(), () => "session-a");

    const result = await selectBrowser.handle(context, { browserId: "windows" });

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("use_default_browser"),
    });
  });
});
