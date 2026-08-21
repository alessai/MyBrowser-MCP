import { afterEach, describe, expect, it, vi } from "vitest";

import { applyInstallerBootstrap, importInstallerBootstrap } from "./installer-bootstrap";

const validBootstrap = {
  schemaVersion: 1,
  bootstrapId: "0123456789abcdef0123456789abcdef",
  serverAddress: "127.0.0.1",
  serverPort: 9009,
  authToken: "a".repeat(64),
  browserName: "MAINPC",
};

const dependencies = (bootstrap: unknown, importedId?: unknown) => ({
  read: vi.fn(async () => bootstrap),
  getImportedId: vi.fn(async () => importedId),
  write: vi.fn(async () => undefined),
});

describe("applyInstallerBootstrap", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("imports a valid localhost bootstrap into extension storage", async () => {
    const deps = dependencies(validBootstrap);

    await expect(applyInstallerBootstrap(deps)).resolves.toBe("imported");
    expect(deps.write).toHaveBeenCalledWith({
      serverAddress: "127.0.0.1",
      serverPort: 9009,
      authToken: "a".repeat(64),
      browserName: "MAINPC",
      installerBootstrapId: validBootstrap.bootstrapId,
    });
  });

  it("does nothing when no installer bootstrap exists", async () => {
    const deps = dependencies(null);

    await expect(applyInstallerBootstrap(deps)).resolves.toBe("missing");
    expect(deps.getImportedId).not.toHaveBeenCalled();
    expect(deps.write).not.toHaveBeenCalled();
  });

  it("imports each bootstrap identifier only once", async () => {
    const deps = dependencies(validBootstrap, validBootstrap.bootstrapId);

    await expect(applyInstallerBootstrap(deps)).resolves.toBe("unchanged");
    expect(deps.write).not.toHaveBeenCalled();
  });

  it.each([
    ["extra fields", { ...validBootstrap, extra: true }],
    ["non-local address", { ...validBootstrap, serverAddress: "192.168.1.10" }],
    ["wrong schema", { ...validBootstrap, schemaVersion: 2 }],
    ["invalid identifier", { ...validBootstrap, bootstrapId: "not-an-id" }],
    ["zero port", { ...validBootstrap, serverPort: 0 }],
    ["fractional port", { ...validBootstrap, serverPort: 9009.5 }],
    ["empty token", { ...validBootstrap, authToken: "" }],
    ["control token", { ...validBootstrap, authToken: "secret\nvalue" }],
    ["oversized token", { ...validBootstrap, authToken: "a".repeat(513) }],
    ["empty browser name", { ...validBootstrap, browserName: "" }],
    ["control browser name", { ...validBootstrap, browserName: "MAIN\nPC" }],
    ["oversized browser name", { ...validBootstrap, browserName: "a".repeat(129) }],
  ])("rejects %s without touching storage", async (_name, bootstrap) => {
    const deps = dependencies(bootstrap);

    await expect(applyInstallerBootstrap(deps)).resolves.toBe("invalid");
    expect(deps.getImportedId).not.toHaveBeenCalled();
    expect(deps.write).not.toHaveBeenCalled();
  });

  it("propagates storage failures without exposing the token", async () => {
    const deps = dependencies(validBootstrap);
    deps.write.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(applyInstallerBootstrap(deps)).rejects.toThrow("storage unavailable");
  });

  it("loads the packaged bootstrap through the extension runtime", async () => {
    const get = vi.fn(async () => ({}));
    const set = vi.fn(async () => undefined);
    const getURL = vi.fn(() => "chrome-extension://extension-id/mybrowser.local.json");
    const fetchBootstrap = vi.fn(async () => ({
      ok: true,
      json: async () => validBootstrap,
    }));
    vi.stubGlobal("chrome", {
      runtime: { getURL },
      storage: { local: { get, set } },
    });
    vi.stubGlobal("fetch", fetchBootstrap);

    await expect(importInstallerBootstrap()).resolves.toBe("imported");
    expect(getURL).toHaveBeenCalledWith("mybrowser.local.json");
    expect(fetchBootstrap).toHaveBeenCalledWith(
      "chrome-extension://extension-id/mybrowser.local.json",
      { cache: "no-store" },
    );
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ authToken: validBootstrap.authToken }));
  });
});
