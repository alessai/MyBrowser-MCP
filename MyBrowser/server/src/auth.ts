import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Config {
  token: string;
  host: string;
  port: number;
}

export const CONFIG_DIR = join(homedir(), ".mybrowser");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

const DEFAULT_CONFIG = {
  host: "127.0.0.1",
  port: 9009,
} as const;

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function safeChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Best-effort hardening. Some filesystems/platforms don't support chmod.
  }
}

function parseConfig(raw: string): Config {
  try {
    const value = JSON.parse(raw) as Partial<Config>;
    validateConfigOverrides(value);
    if (value.token === undefined || value.host === undefined || value.port === undefined) throw new Error();
    return value as Config;
  } catch {
    throw new Error(`Invalid MyBrowser config at ${CONFIG_FILE}; fix or remove it before restarting`);
  }
}

export function validateConfigOverrides(config: Partial<Config>): void {
  if (config.token !== undefined && (typeof config.token !== "string" || config.token.length === 0)) {
    throw new Error("MyBrowser token must not be empty");
  }
  if (config.host !== undefined && (typeof config.host !== "string" || config.host.length === 0)) {
    throw new Error("MyBrowser host must not be empty");
  }
  if (
    config.port !== undefined
    && (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535)
  ) {
    throw new Error("MyBrowser port must be an integer from 1 to 65535");
  }
}

function readCreatedConfig(): Config {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return parseConfig(readFileSync(CONFIG_FILE, "utf8"));
    } catch (error) {
      if (attempt === 19) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  throw new Error("unreachable");
}

function applyOverrides(config: Config, overrides?: Partial<Config>): Config {
  return {
    token: overrides?.token ?? config.token,
    host: overrides?.host ?? config.host,
    port: overrides?.port ?? config.port,
  };
}

export function loadOrCreateConfig(overrides?: Partial<Config>): Config {
  validateConfigOverrides(overrides ?? {});
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  safeChmod(CONFIG_DIR, 0o700);

  let stored: Config;
  try {
    stored = parseConfig(readFileSync(CONFIG_FILE, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const created = applyOverrides({
      token: generateToken(),
      ...DEFAULT_CONFIG,
    }, overrides);
    let fd: number | undefined;
    try {
      fd = openSync(CONFIG_FILE, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(created, null, 2) + "\n");
      fsyncSync(fd);
      stored = created;
    } catch (createError) {
      if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError;
      stored = readCreatedConfig();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  safeChmod(CONFIG_FILE, 0o600);
  return applyOverrides(stored, overrides);
}
