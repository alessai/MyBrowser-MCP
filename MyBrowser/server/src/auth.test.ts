import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);

let home: string;

describe("server configuration", () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mybrowser-config-"));
    vi.resetModules();
    vi.doMock("node:os", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:os")>()),
      homedir: () => home,
    }));
  });

  afterEach(() => {
    vi.doUnmock("node:os");
    rmSync(home, { recursive: true, force: true });
  });

  it("fails closed without replacing a malformed existing token", async () => {
    const configDir = join(home, ".mybrowser");
    const configFile = join(configDir, "config.json");
    mkdirSync(configDir);
    writeFileSync(configFile, "not-json\n");
    const { loadOrCreateConfig } = await import("./auth.js");

    expect(() => loadOrCreateConfig()).toThrow("Invalid MyBrowser config");
    expect(readFileSync(configFile, "utf8")).toBe("not-json\n");
  });

  it("keeps runtime overrides out of an existing config", async () => {
    const { CONFIG_FILE, loadOrCreateConfig } = await import("./auth.js");
    const saved = loadOrCreateConfig();
    const before = readFileSync(CONFIG_FILE, "utf8");
    const beforeMtime = statSync(CONFIG_FILE).mtimeMs;

    expect(loadOrCreateConfig({ host: "0.0.0.0", port: 9010 })).toEqual({
      ...saved,
      host: "0.0.0.0",
      port: 9010,
    });
    expect(readFileSync(CONFIG_FILE, "utf8")).toBe(before);
    expect(statSync(CONFIG_FILE).mtimeMs).toBe(beforeMtime);
  });

  it("persists first-run overrides and reuses the winning token", async () => {
    const { CONFIG_FILE, loadOrCreateConfig } = await import("./auth.js");

    const created = loadOrCreateConfig({ port: 9010 });
    const loaded = loadOrCreateConfig();

    expect(created).toEqual(loaded);
    expect(JSON.parse(readFileSync(CONFIG_FILE, "utf8"))).toEqual(created);
  });

  it("ignores undefined CLI options on first run", async () => {
    const { loadOrCreateConfig } = await import("./auth.js");

    expect(loadOrCreateConfig({ host: undefined, port: undefined, token: undefined })).toMatchObject({
      host: "127.0.0.1",
      port: 9009,
      token: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("converges concurrent first starts on one token", async () => {
    const runner = join(process.cwd(), "node_modules", "vite-node", "vite-node.mjs");
    const fixture = join(process.cwd(), "src", "test-fixtures", "load-config.ts");
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const results = await Promise.all(Array.from({ length: 8 }, () => execFileAsync(
      process.execPath,
      [runner, fixture, "9010"],
      { env },
    )));
    const configs = results.map(({ stdout }) => JSON.parse(stdout));

    expect(new Set(configs.map(({ token }) => token))).toHaveLength(1);
    expect(configs.every(({ port }) => port === 9010)).toBe(true);
  }, 30_000);

  it("rejects invalid first-run overrides before creating config", async () => {
    const { CONFIG_FILE, loadOrCreateConfig } = await import("./auth.js");

    expect(() => loadOrCreateConfig({ port: Number.NaN })).toThrow("port must be an integer");
    expect(() => readFileSync(CONFIG_FILE)).toThrow();
  });
});
