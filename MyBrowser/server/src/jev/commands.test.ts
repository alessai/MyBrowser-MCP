import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerJevCommands, type JevCommandDependencies } from "./commands.js";

const KEY = "apikey_0123456789abcdef_fedcba9876543210";
let dir: string;
let configFile: string;

function run(args: string[], overrides: Partial<JevCommandDependencies> = {}) {
  const output: string[] = [];
  const deps: Partial<JevCommandDependencies> = {
    configFile,
    ensureConfig: () => {},
    stdout: (text) => output.push(text),
    readSecret: vi.fn(async () => `${KEY}\n`),
    verifyKey: vi.fn(async () => ({ model: "jev-1.13.0", ms: 321 })),
    ...overrides,
  };
  const program = new Command().name("mybrowser-mcp").exitOverride();
  registerJevCommands(program, deps);
  return { done: program.parseAsync(["node", "mybrowser-mcp", "jev", ...args]), output, deps };
}

const stored = () => JSON.parse(readFileSync(configFile, "utf8"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mb-jev-cmd-"));
  configFile = join(dir, "config.json");
  writeFileSync(configFile, JSON.stringify({ token: "t".repeat(64), host: "127.0.0.1", port: 9009, jev: { apiKey: "old", vision: true } }), { mode: 0o600 });
});

describe("mybrowser-mcp jev set-key", () => {
  it("prompts for the key, checks it, and saves it without touching other settings", async () => {
    const { done, output, deps } = run(["set-key"]);
    await done;
    expect(deps.readSecret).toHaveBeenCalled();
    expect(deps.verifyKey).toHaveBeenCalledWith(KEY);
    expect(stored()).toEqual({ token: "t".repeat(64), host: "127.0.0.1", port: 9009, jev: { apiKey: KEY, vision: true } });
    expect(statSync(configFile).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["config.json"]);
    expect(output.join("")).toContain("Saved TypeSafe key apikey_012\u20263210");
    expect(output.join("")).not.toContain(KEY);
  });

  it("accepts the key as an argument", async () => {
    await run(["set-key", KEY]).done;
    expect(stored().jev.apiKey).toBe(KEY);
  });

  it("does not save a key TypeSafe rejects", async () => {
    const { done } = run(["set-key", KEY], { verifyKey: vi.fn(async () => { throw new Error("JEV_HTTP_401: unauthorized"); }) });
    await expect(done).rejects.toThrow(/TypeSafe rejected this key/);
    expect(stored().jev.apiKey).toBe("old");
  });

  it("explains how to save anyway when TypeSafe is unreachable", async () => {
    const { done } = run(["set-key", KEY], { verifyKey: vi.fn(async () => { throw new TypeError("fetch failed"); }) });
    await expect(done).rejects.toThrow(/--no-verify/);
    const skipped = run(["set-key", KEY, "--no-verify"], { verifyKey: vi.fn(async () => { throw new Error("must not be called"); }) });
    await skipped.done;
    expect(stored().jev.apiKey).toBe(KEY);
    expect(skipped.output.join("")).toContain("not checked");
  });

  it("rejects an empty key", async () => {
    await expect(run(["set-key"], { readSecret: async () => "  \n" }).done).rejects.toThrow(/No key given/);
  });

  it("creates the config first when there is none", async () => {
    const ensureConfig = vi.fn(() => writeFileSync(join(dir, "config.json"), JSON.stringify({ token: "n".repeat(64), host: "127.0.0.1", port: 9009 })));
    configFile = join(dir, "config.json");
    await run(["set-key", KEY], { ensureConfig }).done;
    expect(ensureConfig).toHaveBeenCalled();
    expect(stored()).toMatchObject({ token: "n".repeat(64), jev: { apiKey: KEY } });
  });
});

describe("mybrowser-mcp jev status / remove", () => {
  it("shows a masked key and turns the layer off", async () => {
    await run(["set-key", KEY]).done;
    const status = run(["status"]);
    await status.done;
    expect(status.output.join("")).toBe("Jev: on, key apikey_012\u20263210, vision on, minConfidence 0.7, timeoutMs 3000\n");

    await run(["remove"]).done;
    expect(stored().jev).toBeUndefined();
    const after = run(["status"]);
    await after.done;
    expect(after.output.join("")).toContain("Jev: off (no key)");
  });
});
