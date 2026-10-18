import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Command } from "commander";
import { CONFIG_FILE, loadOrCreateConfig, validateConfigOverrides } from "../auth.js";
import { askJev } from "./client.js";
import { readJevConfig } from "./config.js";

export interface JevCommandDependencies {
  configFile: string;
  /** Creates the config file (with a fresh token) when it does not exist yet. */
  ensureConfig(): void;
  stdout(text: string): void;
  readSecret(prompt: string): Promise<string>;
  verifyKey(apiKey: string): Promise<{ model: string; ms: number }>;
}

const KEYS_URL = "https://console.typesafe.ai/keys";
const RESTART = "Restart your MCP client (and the MyBrowser hub, if you run one) to apply it.";

async function readSecretFromTerminal(prompt: string): Promise<string> {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    let data = "";
    for await (const chunk of stdin) data += String(chunk);
    return data.split(/\r?\n/)[0] ?? "";
  }
  stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (settle: () => void) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
      settle();
    };
    // Raw mode keeps the key off the screen; nothing is echoed.
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish(() => resolve(value));
        if (ch === "\u0003") return finish(() => reject(new Error("Cancelled")));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}

const defaultDependencies: JevCommandDependencies = {
  configFile: CONFIG_FILE,
  ensureConfig: () => { loadOrCreateConfig(); },
  stdout: (text) => process.stdout.write(text),
  readSecret: readSecretFromTerminal,
  verifyKey: async (apiKey) => {
    const response = await askJev({ apiKey, vision: false, minConfidence: 0.7, timeoutMs: 10_000 }, {
      state: { note: "MyBrowser key check" },
      questions: { ok: { type: "noul", instructions: "Does the `state` contain a note?" } },
    });
    return { model: response.model, ms: response.ms };
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfigObject(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isObject(value)) throw new Error(`Invalid MyBrowser config at ${file}; fix or remove it first`);
  return value;
}

// Atomic replace: a crash mid-write never leaves a truncated config (it holds the auth token).
function writeConfigObject(file: string, value: Record<string, unknown>): void {
  validateConfigOverrides(value);
  const temp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temp);
    throw error;
  }
  closeSync(fd);
  renameSync(temp, file);
}

export function maskKey(key: string): string {
  return key.length > 16 ? `${key.slice(0, 10)}\u2026${key.slice(-4)}` : "(set)";
}

export function registerJevCommands(root: Command, overrides: Partial<JevCommandDependencies> = {}): void {
  const deps = { ...defaultDependencies, ...overrides };
  const jev = root.command("jev").description("Manage the optional TypeSafe Jev decision layer");

  jev.command("set-key [key]")
    .description("Save your TypeSafe API key to the MyBrowser config. Omit the key to be prompted for it (keeps it out of shell history).")
    .option("--no-verify", "Save without checking the key with TypeSafe first")
    .action(async (keyArg: string | undefined, options: { verify: boolean }) => {
      const key = (keyArg === undefined || keyArg === "-" ? await deps.readSecret("TypeSafe API key: ") : keyArg).trim();
      if (key.length === 0) throw new Error(`No key given. Create one at ${KEYS_URL}`);
      if (/\s/.test(key)) throw new Error("The API key must not contain spaces");
      let verified = "not checked";
      if (options.verify) {
        try {
          const result = await deps.verifyKey(key);
          verified = `checked with ${result.model} in ${result.ms}ms`;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/^JEV_HTTP_(401|403)/.test(message)) throw new Error(`TypeSafe rejected this key. Check it at ${KEYS_URL}`);
          throw new Error(`Could not check the key with TypeSafe (${message.split(":")[0]}). Run again with --no-verify to save it anyway.`);
        }
      }
      deps.ensureConfig();
      const config = readConfigObject(deps.configFile);
      config.jev = { ...(isObject(config.jev) ? config.jev : {}), apiKey: key };
      writeConfigObject(deps.configFile, config);
      deps.stdout(`Saved TypeSafe key ${maskKey(key)} to ${deps.configFile} (${verified}).\n${RESTART}\n`);
    });

  jev.command("status")
    .description("Show whether the Jev layer is configured")
    .action(() => {
      let config: Record<string, unknown>;
      try {
        config = readConfigObject(deps.configFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        deps.stdout("Jev: off (no MyBrowser config yet). Turn it on with: mybrowser-mcp jev set-key\n");
        return;
      }
      const jevConfig = readJevConfig(config.jev);
      deps.stdout(jevConfig
        ? `Jev: on, key ${maskKey(jevConfig.apiKey)}, vision ${jevConfig.vision ? "on" : "off"}, minConfidence ${jevConfig.minConfidence}, timeoutMs ${jevConfig.timeoutMs}\n`
        : "Jev: off (no key). Turn it on with: mybrowser-mcp jev set-key\n");
    });

  jev.command("remove")
    .description("Delete the TypeSafe key and turn the Jev layer off")
    .action(() => {
      let config: Record<string, unknown>;
      try {
        config = readConfigObject(deps.configFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        deps.stdout("Jev is already off.\n");
        return;
      }
      if (config.jev === undefined) {
        deps.stdout("Jev is already off.\n");
        return;
      }
      delete config.jev;
      writeConfigObject(deps.configFile, config);
      deps.stdout(`Removed the TypeSafe key from ${deps.configFile}. ${RESTART}\n`);
    });
}
