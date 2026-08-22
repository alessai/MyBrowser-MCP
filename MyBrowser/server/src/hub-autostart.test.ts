import { describe, expect, it, vi } from "vitest";

import {
  buildHubEnvironment,
  createDetachedHubEnsurer,
  HUB_AUTOSTART_TOKEN_ENV,
} from "./hub-autostart.js";

const options = {
  host: "127.0.0.1",
  port: 9009,
  token: "secret",
  entrypoint: "/package/dist/index.js",
};

describe("detached local hub startup", () => {
  it("does nothing when the configured listener is already available", async () => {
    const spawnHub = vi.fn();
    const ensureHub = createDetachedHubEnsurer(options, {
      isListening: vi.fn().mockResolvedValue(true),
      spawnHub,
      sleep: vi.fn(),
    });

    await ensureHub();

    expect(spawnHub).not.toHaveBeenCalled();
  });

  it("spawns one strict detached hub and waits for its listener", async () => {
    const spawnHub = vi.fn();
    const isListening = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const ensureHub = createDetachedHubEnsurer(options, {
      isListening,
      spawnHub,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    await Promise.all([ensureHub(), ensureHub()]);

    expect(spawnHub).toHaveBeenCalledTimes(1);
    expect(spawnHub).toHaveBeenCalledWith(options);
  });

  it("fails clearly when the detached hub never becomes reachable", async () => {
    const ensureHub = createDetachedHubEnsurer(
      { ...options, startupTimeoutMs: 1 },
      {
        isListening: vi.fn().mockResolvedValue(false),
        spawnHub: vi.fn(),
        sleep: vi.fn().mockResolvedValue(undefined),
      },
    );

    await expect(ensureHub()).rejects.toThrow("Detached hub did not start");
  });

  it("refuses detached startup for a non-loopback host", () => {
    expect(() => createDetachedHubEnsurer({ ...options, host: "0.0.0.0" })).toThrow(
      "--ensure-hub requires a loopback host",
    );
  });

  it("does not keep unrelated client secrets in the detached hub", () => {
    process.env.MYBROWSER_TEST_SECRET = "do-not-copy";
    try {
      const env = buildHubEnvironment("hub-token");
      expect(env[HUB_AUTOSTART_TOKEN_ENV]).toBe("hub-token");
      expect(env.MYBROWSER_TEST_SECRET).toBeUndefined();
    } finally {
      delete process.env.MYBROWSER_TEST_SECRET;
    }
  });
});
