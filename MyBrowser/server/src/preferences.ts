import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./auth.js";

export interface Preferences {
  /** Stable browser name used as the shared default target. */
  defaultBrowserName?: string;
}

export const PREFERENCES_FILE = join(CONFIG_DIR, "preferences.json");

function safeChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Best-effort hardening. Some filesystems/platforms don't support chmod.
  }
}

function ensurePreferencesDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  safeChmod(CONFIG_DIR, 0o700);
}

export function loadPreferences(): Preferences {
  try {
    const raw = readFileSync(PREFERENCES_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Preferences;
    const defaultBrowserName =
      typeof parsed.defaultBrowserName === "string" &&
      parsed.defaultBrowserName.trim().length > 0
        ? parsed.defaultBrowserName
        : undefined;
    return defaultBrowserName ? { defaultBrowserName } : {};
  } catch {
    return {};
  }
}

export function savePreferences(preferences: Preferences): void {
  ensurePreferencesDir();
  const normalized: Preferences = {};
  if (
    typeof preferences.defaultBrowserName === "string" &&
    preferences.defaultBrowserName.trim().length > 0
  ) {
    normalized.defaultBrowserName = preferences.defaultBrowserName;
  }

  writeFileSync(PREFERENCES_FILE, JSON.stringify(normalized, null, 2) + "\n", {
    mode: 0o600,
  });
  safeChmod(PREFERENCES_FILE, 0o600);
}
