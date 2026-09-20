// Atomic, symlink-hardened landing for transferred files.
// Security patterns copied from:
//  - server/src/telemetry/writer.ts:469-561 (assertNoSymlinkAncestors,
//    descriptor/path identity verification, directory fsync)
//  - server/src/tools/record.ts:647-652,675-738 (O_NOFOLLOW fail-closed,
//    exact-mode verification, dev/ino re-verification)
//  - server/src/notes.ts:247-352 (provenance/metadata written BEFORE payload)
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  TRANSFERS_DOWNLOADS_DIR,
  TRANSFERS_TMP_DIR,
  TransferError,
  sanitizeTransferFilename,
} from "./retention.js";

export interface ProvenanceRecord {
  sourceUrl?: string;
  browserId?: string;
  sessionId: string;
  transferId: string;
  sha256: string;
  bytes: number;
  mimeType: string;
  receivedAt: string;
}

// O_NOFOLLOW is required for every open of transfer artifacts; if the
// platform does not expose it we fail closed (record.ts:647-652 pattern).
export function requirePositiveNoFollowFlag(flag: number | undefined): number {
  if (!Number.isInteger(flag) || (flag ?? 0) <= 0) {
    throw new TransferError(
      "TRANSFER_STORAGE_FAILED",
      "filesystem does not support O_NOFOLLOW; refusing to land transfers",
    );
  }
  return flag as number;
}

function lstatIfPresent(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

// writer.ts:491-504 pattern — refuse any symlink anywhere on the path.
export function assertNoSymlinkAncestors(path: string): void {
  const absolute = resolve(path);
  const segments = absolute.split(/[\\/]+/u).filter(Boolean);
  // Drop the drive/root component ("", "C:", "/") by rebuilding from root.
  let current = absolute.startsWith("/") ? "/" : "";
  for (const segment of segments) {
    if (/^[A-Za-z]:$/.test(segment)) continue;
    current = join(current, segment);
    const stats = lstatIfPresent(current);
    if (!stats) break;
    if (stats.isSymbolicLink()) {
      throw new TransferError(
        "TRANSFER_STORAGE_FAILED",
        `transfer storage path contains a symbolic link: ${current}`,
      );
    }
  }
}

function ensurePrivateDir(dir: string): void {
  assertNoSymlinkAncestors(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertNoSymlinkAncestors(dir);
  const stats = lstatSync(dir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new TransferError(
      "TRANSFER_STORAGE_FAILED",
      `transfer directory is not a private directory: ${dir}`,
    );
  }
}

export function transfersTmpDir(root: string): string {
  return join(root, TRANSFERS_TMP_DIR);
}

export function transfersDownloadsDir(root: string): string {
  return join(root, TRANSFERS_DOWNLOADS_DIR);
}

export function sessionDownloadDir(root: string, sessionId: string): string {
  // sessionId is hub-generated (isValidV2SessionId) and this path is built
  // from network-supplied data, so fail closed: the sessionId must BE its
  // own basename (basename("..") is "..", which would join-escape one level).
  if (typeof sessionId !== "string" || sessionId.length === 0
    || sessionId.length > 128 || basename(sessionId) !== sessionId) {
    throw new TransferError("TRANSFER_REJECTED", `invalid sessionId ${JSON.stringify(String(sessionId))}`);
  }
  return join(transfersDownloadsDir(root), sessionId);
}

export function ensureTransfersDirTree(root: string): void {
  ensurePrivateDir(transfersTmpDir(root));
  ensurePrivateDir(transfersDownloadsDir(root));
}

/**
 * Create (exclusively) the staged `.part` file for a transfer.
 * O_EXCL|O_NOFOLLOW create, mode 0600, then dev/ino identity verification.
 * Returns the fd; caller owns closing and unlinking on failure.
 */
export function openPartFile(root: string, transferId: string): {
  fd: number;
  path: string;
  identity: { dev: number; ino: number };
} {
  ensureTransfersDirTree(root);
  const noFollow = requirePositiveNoFollowFlag(fsConstants.O_NOFOLLOW);
  const path = join(transfersTmpDir(root), `${transferId}.part`);
  const fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow, 0o600);
  try {
    const descriptorStats = fstatSync(fd);
    if (!descriptorStats.isFile()) {
      throw new TransferError("TRANSFER_STORAGE_FAILED", "staged part file is not a regular file");
    }
    const pathStats = lstatSync(path);
    if (pathStats.isSymbolicLink() || pathStats.dev !== descriptorStats.dev || pathStats.ino !== descriptorStats.ino) {
      throw new TransferError("TRANSFER_STORAGE_FAILED", "staged part file identity mismatch");
    }
    return { fd, path, identity: { dev: descriptorStats.dev, ino: descriptorStats.ino } };
  } catch (error) {
    try {
      closeSync(fd);
    } catch { /* ignore */ }
    try {
      unlinkSync(path);
    } catch { /* ignore */ }
    throw error;
  }
}

export function discardPart(root: string, transferId: string): void {
  try {
    unlinkSync(join(transfersTmpDir(root), `${transferId}.part`));
  } catch { /* already gone */ }
}

function timestampSegment(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

/**
 * Final landing path `downloads/<sessionId>/<YYYYMMDD-HHmmss>-<filename>`
 * with a numeric dedupe suffix when the name is taken. Existing symlinks at
 * the candidate path are not followed: lstat sees them and we dedupe past.
 */
export function planLandingPath(
  root: string,
  sessionId: string,
  filename: string,
  now: Date = new Date(),
): string {
  const dir = sessionDownloadDir(root, sessionId);
  const base = `${timestampSegment(now)}-${sanitizeTransferFilename(filename)}`;
  let candidate = join(dir, base);
  let counter = 0;
  while (lstatIfPresent(candidate) !== undefined) {
    counter += 1;
    candidate = join(dir, `${base}-${counter}`);
    if (counter > 1000) {
      throw new TransferError("TRANSFER_STORAGE_FAILED", "cannot allocate a unique landing path");
    }
  }
  return candidate;
}

function syncDirectory(dir: string): void {
  // record.ts:654-673 syncRecordingDirectory pattern — open O_RDONLY|O_NOFOLLOW
  // (O_DIRECTORY when available), fsync, close.
  const noFollow = requirePositiveNoFollowFlag(fsConstants.O_NOFOLLOW);
  const directoryFlag = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
  const fd = openSync(dir, fsConstants.O_RDONLY | directoryFlag | noFollow);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeProvenanceSidecar(finalPath: string, record: ProvenanceRecord): void {
  const sidecarPath = `${finalPath}.provenance.json`;
  assertNoSymlinkAncestors(sidecarPath);
  const noFollow = requirePositiveNoFollowFlag(fsConstants.O_NOFOLLOW);
  // Write sidecar atomically in .tmp, then rename into place. The sidecar
  // is written BEFORE the payload rename (notes.ts:335-352 ordering: an
  // orphaned sidecar without a payload is harmless; payload without
  // provenance is invisible data loss).
  const tmpPath = `${sidecarPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    const fd = openSync(tmpPath, fsConstants.O_RDONLY | noFollow);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, sidecarPath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch { /* ignore */ }
    throw error;
  }
}

export interface LandingRequest {
  root: string;
  sessionId: string;
  filename: string;
  mimeType: string;
  sha256: string;
  totalBytes: number;
  sourceUrl?: string;
  browserId?: string;
  transferId: string;
  receivedAt?: Date;
}

export interface LandingResult {
  finalPath: string;
  sidecarPath: string;
}

/**
 * Move a fully-verified staged part file to its final landing path.
 * Caller has already closed the fd after verifying hash/size. Order:
 *  1. verify staged size + identity
 *  2. write provenance sidecar (BEFORE payload — notes.ts ordering)
 *  3. rename staged file into downloads/<sessionId>/
 *  4. fsync the session directory and re-verify dev/ino of the landed file
 */
export function finalizeLanding(part: {
  fd: number;
  path: string;
  identity: { dev: number; ino: number };
}, request: LandingRequest): LandingResult {
  const { root, sessionId } = request;
  const descriptorStats = fstatSync(part.fd);
  if (descriptorStats.size !== request.totalBytes) {
    throw new TransferError(
      "TRANSFER_SIZE_MISMATCH",
      `staged size ${descriptorStats.size} does not match declared ${request.totalBytes}`,
    );
  }
  fsyncSync(part.fd);
  closeSync(part.fd);

  const dir = sessionDownloadDir(root, sessionId);
  ensurePrivateDir(dir);
  assertNoSymlinkAncestors(dir);

  const receivedAt = (request.receivedAt ?? new Date()).toISOString();
  const finalPath = planLandingPath(root, sessionId, request.filename, request.receivedAt ?? new Date());
  // Provenance BEFORE payload (notes.ts:335-352).
  writeProvenanceSidecar(finalPath, {
    sourceUrl: request.sourceUrl,
    browserId: request.browserId,
    sessionId,
    transferId: request.transferId,
    sha256: request.sha256,
    bytes: request.totalBytes,
    mimeType: request.mimeType,
    receivedAt,
  });
  try {
    renameSync(part.path, finalPath);
  } catch (error) {
    try {
      unlinkSync(`${finalPath}.provenance.json`);
    } catch { /* ignore */ }
    throw new TransferError("TRANSFER_STORAGE_FAILED", `failed to land transfer: ${String(error)}`);
  }
  try {
    syncDirectory(dir);
  } catch { /* directory fsync unsupported — payload is already renamed */ }

  // dev/ino re-verification (writer.ts:473-478 / record.ts:675-738): the
  // rename must have landed the exact inode we staged, never a swapped path.
  const landed = lstatSync(finalPath);
  if (landed.isSymbolicLink() || landed.dev !== part.identity.dev || landed.ino !== part.identity.ino) {
    throw new TransferError("TRANSFER_STORAGE_FAILED", "landed file identity mismatch after rename");
  }
  return { finalPath, sidecarPath: `${finalPath}.provenance.json` };
}

/** Read back a provenance sidecar (used by tests and tooling). */
export function readProvenance(path: string): ProvenanceRecord {
  return JSON.parse(readFileSync(path, "utf-8")) as ProvenanceRecord;
}
