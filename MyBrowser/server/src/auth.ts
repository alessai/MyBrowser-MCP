import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Config {
  token: string;
  host: string;
  port: number;
}

export const CONFIG_DIR = join(homedir(), ".mybrowser");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function loadOrCreateConfig(overrides?: Partial<Config>): Config {
  let config: Config;
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    config = JSON.parse(raw) as Config;
  } catch {
    config = {
      token: generateToken(),
      host: "0.0.0.0",
      port: 9009,
    };
  }

  if (overrides?.host !== undefined) config.host = overrides.host;
  if (overrides?.port !== undefined) config.port = overrides.port;
  if (overrides?.token !== undefined) config.token = overrides.token;

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");

  return config;
}
