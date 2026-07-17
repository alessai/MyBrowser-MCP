import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import type { TelemetryConfig } from "./types.js";

const DAY_MS = 86_400_000;
const MEBIBYTE = 1024 * 1024;

const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 90;
const MIN_TOTAL_MIB = 16;
const MAX_TOTAL_MIB = 2_048;

export const DEFAULT_TELEMETRY_LIMITS = Object.freeze({
  retentionMs: 14 * DAY_MS,
  maxTotalBytes: 256 * MEBIBYTE,
  maxFileBytes: 32 * MEBIBYTE,
  maxEventBytes: 16 * 1024,
});

export interface TelemetryCliOptions {
  traceInternal?: boolean;
  traceDir?: string;
  traceRetentionDays?: number;
  traceMaxMb?: number;
}

function parseClampedNumber(
  value: number | undefined,
  label: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return Math.min(maximum, Math.max(minimum, value));
}

function resolveTraceDirectory(raw: string | undefined, home: string): string {
  if (raw === undefined) return resolve(home, ".mybrowser", "traces");
  if (raw.length === 0 || raw.includes("\0")) {
    throw new Error("trace directory must be a non-empty path without NUL bytes");
  }
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return resolve(home, raw.slice(2));
  if (raw.startsWith("~")) {
    throw new Error("trace directory does not support other users' home expansion");
  }
  return isAbsolute(raw) ? resolve(raw) : resolve(home, raw);
}

export function parseTelemetryConfig(
  cli: TelemetryCliOptions = {},
  home = homedir(),
): TelemetryConfig {
  const retentionDays = parseClampedNumber(
    cli.traceRetentionDays,
    "trace retention days",
    MIN_RETENTION_DAYS,
    MAX_RETENTION_DAYS,
    DEFAULT_TELEMETRY_LIMITS.retentionMs / DAY_MS,
  );
  const maxTotalMiB = parseClampedNumber(
    cli.traceMaxMb,
    "trace maximum MiB",
    MIN_TOTAL_MIB,
    MAX_TOTAL_MIB,
    DEFAULT_TELEMETRY_LIMITS.maxTotalBytes / MEBIBYTE,
  );
  const maxTotalBytes = maxTotalMiB * MEBIBYTE;

  return {
    enabled: cli.traceInternal === true,
    directory: resolveTraceDirectory(cli.traceDir, home),
    keyPath: resolve(home, ".mybrowser", "trace-key"),
    retentionMs: retentionDays * DAY_MS,
    maxTotalBytes,
    maxFileBytes: Math.min(DEFAULT_TELEMETRY_LIMITS.maxFileBytes, maxTotalBytes),
    maxEventBytes: DEFAULT_TELEMETRY_LIMITS.maxEventBytes,
  };
}

export function resolveProcessTelemetryConfig(
  cli: TelemetryCliOptions,
  standaloneHub: boolean,
  home = homedir(),
): TelemetryConfig | undefined {
  if (standaloneHub) return undefined;
  return parseTelemetryConfig(cli, home);
}
