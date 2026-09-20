// File-transfer support: config, error codes, filename sanitization, retention.
// Spec: TRANSFER-SPEC.md — config section + retention sweep semantics.
import {
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TransfersConfig {
  maxFileMb: number;
  retentionDays: number;
  maxTotalMb: number;
}

export const DEFAULT_TRANSFERS_CONFIG: TransfersConfig = {
  maxFileMb: 40,
  retentionDays: 7,
  maxTotalMb: 2048,
};

// Validation ranges per TRANSFER-SPEC.md. Invalid config fails closed at
// startup (auth.ts) — same posture as localUrlHost validation.
const LIMITS = {
  maxFileMb: { min: 1, max: 100 },
  retentionDays: { min: 1, max: 90 },
  maxTotalMb: { min: 16, max: 20480 },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRange(
  config: Record<string, unknown>,
  key: keyof TransfersConfig,
): number {
  const value = config[key];
  const { min, max } = LIMITS[key];
  if (
    typeof value !== "number" || !Number.isSafeInteger(value)
    || value < min || value > max
  ) {
    throw new TransferError(
      "TRANSFER_REJECTED",
      `Invalid transfers config: "${key}" must be an integer between ${min} and ${max}`,
    );
  }
  return value;
}

/**
 * Validate a raw `transfers` config section. `undefined` (section absent)
 * yields the documented defaults. Any present-but-invalid value throws —
 * callers treat a throw as fatal (fail closed).
 */
export function readTransfersConfig(value: unknown): TransfersConfig {
  if (value === undefined) return { ...DEFAULT_TRANSFERS_CONFIG };
  if (!isRecord(value)) {
    throw new TransferError(
      "TRANSFER_REJECTED",
      'Invalid transfers config: expected an object like { "maxFileMb": 40, "retentionDays": 7, "maxTotalMb": 2048 }',
    );
  }
  // Exact-key validation (protocol.ts house style): a typo like
  // "retensionDays" must fail closed, not silently fall back to default.
  const allowed = new Set(["maxFileMb", "retentionDays", "maxTotalMb"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TransferError(
        "TRANSFER_REJECTED",
        `Invalid transfers config: unknown key "${key}" (allowed: ${[...allowed].join(", ")})`,
      );
    }
  }
  return {
    maxFileMb: validateRange(value, "maxFileMb"),
    retentionDays: validateRange(value, "retentionDays"),
    maxTotalMb: validateRange(value, "maxTotalMb"),
  };
}

/**
 * Read the transfers section from a config file, falling back to defaults
 * when the file does not exist or has no transfers section. A present but
 * INVALID section still throws — same fail-closed posture as startup.
 */
export function loadTransfersConfig(configFile: string): TransfersConfig {
  let raw: string;
  try {
    raw = readFileSync(configFile, "utf-8");
  } catch {
    return { ...DEFAULT_TRANSFERS_CONFIG };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_TRANSFERS_CONFIG };
  }
  if (!isRecord(parsed)) return { ...DEFAULT_TRANSFERS_CONFIG };
  return readTransfersConfig(parsed.transfers);
}

export function defaultTransfersRoot(): string {
  return join(homedir(), ".mybrowser", "transfers");
}

export const TRANSFERS_TMP_DIR = ".tmp";
export const TRANSFERS_DOWNLOADS_DIR = "downloads";

// ---- Error codes (wire-visible in transfer_ack.code) ----
export const TRANSFER_ERROR_CODES = [
  "TRANSFER_OUT_OF_ORDER",
  "TRANSFER_TOO_LARGE",
  "TRANSFER_BAD_FILENAME",
  "TRANSFER_REJECTED",
  "TRANSFER_HASH_MISMATCH",
  "TRANSFER_SIZE_MISMATCH",
  "TRANSFER_TIMEOUT",
  "TRANSFER_STORAGE_FAILED",
  "TRANSFER_SESSION_MISMATCH",
  "TRANSFER_CONCURRENCY_LIMIT",
] as const;
export type TransferErrorCode = (typeof TRANSFER_ERROR_CODES)[number];

export class TransferError extends Error {
  readonly code: TransferErrorCode;
  constructor(code: TransferErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "TransferError";
    this.code = code;
  }
}

// ---- Filename sanitization (server side, spec regex) ----
// `^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$` after basename() — no separators, no
// leading dot (blocks .htaccess-style names and ".."), bounded length.
export function sanitizeTransferFilename(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new TransferError("TRANSFER_BAD_FILENAME", "filename must be a string");
  }
  // Spec: reject (don't rewrite) traversal, separators, and leading dots —
  // silent stripping would change the user-visible download name.
  if (raw.includes("/") || raw.includes("\\")) {
    throw new TransferError("TRANSFER_BAD_FILENAME", `filename must not contain path separators (got ${JSON.stringify(raw)})`);
  }
  const base = raw;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(base)) {
    throw new TransferError(
      "TRANSFER_BAD_FILENAME",
      `filename must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$ (got ${JSON.stringify(raw)})`,
    );
  }
  return base;
}

// ---- Retention sweep ----
export interface SweepResult {
  deletedFiles: number;
  freedBytes: number;
}

interface FileEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

function listRegularFiles(dir: string): FileEntry[] {
  const entries: FileEntry[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return entries;
  }
  for (const name of names) {
    const path = join(dir, name);
    let stats;
    try {
      stats = lstatSync(path);
    } catch {
      continue; // raced with deletion
    }
    // Never follow symlinks (fail-closed pattern from record.ts):
    // a symlink is unlinked itself, its target is never read or removed.
    if (stats.isSymbolicLink()) {
      try {
        unlinkSync(path);
      } catch {
        /* best effort */
      }
      continue;
    }
    if (stats.isDirectory()) {
      entries.push(...listRegularFiles(path));
      continue;
    }
    if (!stats.isFile()) continue;
    entries.push({ path, size: stats.size, mtimeMs: stats.mtimeMs });
  }
  return entries;
}

function deleteFile(path: string): boolean {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      unlinkSync(path);
    } else {
      rmSync(path, { force: true });
    }
    return true;
  } catch {
    return false;
  }
}

function isSidecar(path: string): boolean {
  return path.endsWith(".provenance.json");
}

/**
 * Sweep the transfers downloads tree:
 *  - files (and their provenance sidecars) older than retentionDays are deleted
 *  - then maxTotalMb aggregate budget is enforced by deleting oldest first
 * Symlinks are never followed — they are unlinked as-is.
 */
export function sweepTransfersRoot(
  root: string,
  config: TransfersConfig,
  now: number = Date.now(),
): SweepResult {
  const downloadsDir = join(root, TRANSFERS_DOWNLOADS_DIR);
  const files = listRegularFiles(downloadsDir);
  let deletedFiles = 0;
  let freedBytes = 0;

  const maxAgeMs = config.retentionDays * 24 * 60 * 60 * 1000;
  const survivors: FileEntry[] = [];
  for (const entry of files) {
    // Age by payload mtime; provenance sidecars ride along with their file.
    const twinPath = isSidecar(entry.path)
      ? entry.path.slice(0, -".provenance.json".length)
      : `${entry.path}.provenance.json`;
    const twin = files.find((candidate) => candidate.path === twinPath);
    const referenceMtime = twin && !isSidecar(entry.path)
      ? twin.mtimeMs
      : entry.mtimeMs;
    if (now - referenceMtime > maxAgeMs) {
      if (deleteFile(entry.path)) {
        deletedFiles += 1;
        freedBytes += entry.size;
        // The provenance sidecar rides along with its evicted payload.
        const sidecarTwin = isSidecar(entry.path)
          ? entry.path.slice(0, -".provenance.json".length)
          : `${entry.path}.provenance.json`;
        if (files.some((candidate) => candidate.path === sidecarTwin)) {
          deleteFile(sidecarTwin);
          deletedFiles += 1;
        }
      }
      continue;
    }
    survivors.push(entry);
  }

  let totalBytes = survivors.reduce((sum, entry) => sum + entry.size, 0);
  const budgetBytes = config.maxTotalMb * 1024 * 1024;
  if (totalBytes > budgetBytes) {
    const ordered = [...survivors].sort((a, b) =>
      a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path),
    );
    for (const entry of ordered) {
      if (totalBytes <= budgetBytes) break;
      if (!deleteFile(entry.path)) continue;
      deletedFiles += 1;
      freedBytes += entry.size;
      totalBytes -= entry.size;
      // Remove the provenance sidecar with its payload (symlink-safe).
      const sidecar = isSidecar(entry.path)
        ? entry.path
        : `${entry.path}.provenance.json`;
      deleteFile(sidecar);
    }
  }
  return { deletedFiles, freedBytes };
}

// Used by landing/registry for size math.
export function megabytesToBytes(mb: number): number {
  return mb * 1024 * 1024;
}
