import { describe, expect, it, vi } from "vitest";

import type { Context } from "../context.js";
import { browserStorage } from "./storage.js";

function createContext() {
  return { sendSocketMessage: vi.fn() } as unknown as Context;
}

describe("browser_storage cookie clear guard", () => {
  it("refuses a domain-less cookie clear without explicit confirmation", async () => {
    const context = createContext();

    await expect(
      browserStorage.handle(context, { action: "clear", type: "cookies" }),
    ).rejects.toThrow(/confirmWipeAllCookies/);

    expect(context.sendSocketMessage).not.toHaveBeenCalled();
  });

  it("forwards domain-scoped cookie clears without confirmation", async () => {
    const context = createContext();

    await browserStorage.handle(context, {
      action: "clear",
      type: "cookies",
      domain: "example.com",
    });

    expect(context.sendSocketMessage).toHaveBeenCalledWith("browser_storage", {
      action: "clear",
      type: "cookies",
      domain: "example.com",
    });
  });

  it("forwards a confirmed full cookie wipe", async () => {
    const context = createContext();

    await browserStorage.handle(context, {
      action: "clear",
      type: "cookies",
      confirmWipeAllCookies: true,
    });

    expect(context.sendSocketMessage).toHaveBeenCalledWith("browser_storage", {
      action: "clear",
      type: "cookies",
      confirmWipeAllCookies: true,
    });
  });

  it("does not gate non-cookie or non-clear storage operations", async () => {
    const context = createContext();

    await browserStorage.handle(context, { action: "clear", type: "localStorage" });

    expect(context.sendSocketMessage).toHaveBeenCalledWith("browser_storage", {
      action: "clear",
      type: "localStorage",
    });
  });

  it("documents the blast radius and the confirmation flag in the schema", () => {
    expect(browserStorage.schema.description).toContain("ALL browser cookies");
    expect(browserStorage.schema.description).toContain("confirmWipeAllCookies");
  });
});
