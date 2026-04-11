import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  readdirSync,
  unlinkSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NoteStatus = "pending" | "archived";

export interface NoteViewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  dpr: number;
}

export interface NoteElementRef {
  ref?: string;
  role?: string;
  name?: string;
  tagName?: string;
}

export interface NoteMetadata {
  id: string;
  createdAt: string;
  url: string;
  title: string;
  note: string;
  status: NoteStatus;
  viewport?: NoteViewport;
  nearestElement?: NoteElementRef;
  archivedAt?: string;
  resolution?: string;
}

export interface Note {
  metadata: NoteMetadata;
  pngBase64: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const MYBROWSER_DIR = join(homedir(), ".mybrowser");
const NOTES_DIR = join(MYBROWSER_DIR, "notes");
const PENDING_DIR = join(NOTES_DIR, "pending");
const ARCHIVED_DIR = join(NOTES_DIR, "archived");

let orphanSweepDone = false;

export function ensureNotesDirectories(): void {
  mkdirSync(PENDING_DIR, { recursive: true });
  mkdirSync(ARCHIVED_DIR, { recursive: true });
  // Sweep any crash-leftover orphans once per process lifetime. Runs
  // lazily at first fs touch so it doesn't block server startup.
  if (!orphanSweepDone) {
    orphanSweepDone = true;
    try {
      sweepOrphans();
    } catch {
      /* best-effort; orphans stay invisible via the read-side filter */
    }
  }
}

/**
 * Scan both note directories for orphaned .json/.png/.tmp files (left
 * behind by a crash mid-archive or mid-save) and remove them. Safe to
 * run at any time — the read path filters orphans out regardless, so
 * this is a pure disk-space reclaimer.
 */
function sweepOrphans(): void {
  for (const status of ["pending", "archived"] as NoteStatus[]) {
    const dir = dirFor(status);
    if (!existsSync(dir)) continue;
    const seen = new Set<string>();
    let changed = false;

    // First pass: remove stray .tmp files from interrupted atomic writes.
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".tmp")) {
        try {
          unlinkSync(join(dir, file));
          changed = true;
        } catch {
          /* ignore */
        }
      } else if (file.endsWith(".json") || file.endsWith(".png")) {
        const id = file.slice(0, file.lastIndexOf("."));
        if (isValidNoteId(id)) seen.add(id);
      }
    }
    // Second pass: for every id seen, unlink whichever side is orphaned.
    for (const id of seen) {
      const jsonExists = existsSync(metaPath(status, id));
      const pngExists = existsSync(pngPath(status, id));
      if (jsonExists && !pngExists) {
        try {
          unlinkSync(metaPath(status, id));
          changed = true;
        } catch {
          /* ignore */
        }
      } else if (pngExists && !jsonExists) {
        try {
          unlinkSync(pngPath(status, id));
          changed = true;
        } catch {
          /* ignore */
        }
      }
    }

    // Fsync the dir once at the end so all the unlinks are durable as a
    // batch. Skipped when nothing changed to avoid a pointless sync.
    if (changed) fsyncPath(dir);
  }
}

function dirFor(status: NoteStatus): string {
  return status === "pending" ? PENDING_DIR : ARCHIVED_DIR;
}

// IDs must match this exact shape; anything else is rejected before it
// reaches the filesystem. Prevents path traversal via caller-supplied ids.
const NOTE_ID_RE = /^note_[0-9a-f]{32}$/;

export function isValidNoteId(id: string): boolean {
  return typeof id === "string" && NOTE_ID_RE.test(id);
}

function requireValidNoteId(id: string): void {
  if (!isValidNoteId(id)) {
    throw new Error(`Invalid note id: "${id}"`);
  }
}

function metaPath(status: NoteStatus, id: string): string {
  requireValidNoteId(id);
  return join(dirFor(status), `${id}.json`);
}

function pngPath(status: NoteStatus, id: string): string {
  requireValidNoteId(id);
  return join(dirFor(status), `${id}.png`);
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function generateNoteId(): string {
  // randomUUID has 122 bits of entropy; strip dashes for a filesystem-safe id.
  return `note_${randomUUID().replace(/-/g, "")}`;
}

// ---------------------------------------------------------------------------
// Atomic write helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort `fsync` on a file path. Safe to call on missing files (no-op).
 * Surviving process crash is already guaranteed by the `tmp + rename` +
 * completeness-filter pattern in this module; this adds survival against
 * host power loss by flushing dirty pages to disk. Silent on failure
 * because fsync is not supported on every filesystem (e.g. some FUSE).
 */
function fsyncPath(path: string): void {
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* fsync not critical for correctness — completeness filter handles crashes */
  }
}

function atomicWriteJson(path: string, data: unknown): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fsyncPath(tmp);
  renameSync(tmp, path);
  // Also fsync the parent dir so the rename is durable.
  fsyncPath(dirname(path));
}

function atomicWriteBytes(path: string, bytes: Buffer): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, bytes);
  fsyncPath(tmp);
  renameSync(tmp, path);
  fsyncPath(dirname(path));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SaveNoteInput {
  url: string;
  title: string;
  note: string;
  viewport?: NoteViewport;
  nearestElement?: NoteElementRef;
  pngBase64: string;
}

const MAX_NOTE_TEXT_LEN = 4_000;
const MAX_URL_LEN = 2_000;
const MAX_TITLE_LEN = 500;
const MAX_PNG_BYTES = 20 * 1024 * 1024; // 20 MB hard cap after base64 decode

function trim(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.length > max ? value.slice(0, max) : value;
}

// Canonical standard base64 (RFC 4648). Enforces the length-quad invariant
// so malformed tails like `A`, `AA`, `AAA`, or `AA=` are rejected.
// URL-safe base64 (`-` / `_`) is explicitly NOT accepted — the extension is
// expected to send standard base64 only.
const BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// PNG magic bytes (RFC 2083 §3.1).
const PNG_MAGIC = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function hasPngMagic(buf: Buffer): boolean {
  if (buf.length < PNG_MAGIC.length) return false;
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (buf[i] !== PNG_MAGIC[i]) return false;
  }
  return true;
}

export function saveNote(input: SaveNoteInput): NoteMetadata {
  // Validate everything BEFORE touching the filesystem — not even mkdir.
  // (ensureNotesDirectories is called later, after all checks pass.)

  if (typeof input.url !== "string") {
    throw new Error("saveNote: url must be a string");
  }
  if (typeof input.title !== "string") {
    throw new Error("saveNote: title must be a string");
  }
  if (typeof input.note !== "string") {
    throw new Error("saveNote: note must be a string");
  }
  if (input.url.length > MAX_URL_LEN) {
    throw new Error(`saveNote: url exceeds ${MAX_URL_LEN} chars`);
  }
  if (input.title.length > MAX_TITLE_LEN) {
    throw new Error(`saveNote: title exceeds ${MAX_TITLE_LEN} chars`);
  }
  if (input.note.length > MAX_NOTE_TEXT_LEN) {
    throw new Error(`saveNote: note exceeds ${MAX_NOTE_TEXT_LEN} chars`);
  }
  if (typeof input.pngBase64 !== "string" || input.pngBase64.length === 0) {
    throw new Error("saveNote: pngBase64 is required");
  }
  // Rough pre-decode guard — base64 expands ~4/3, so 20 MB binary ≈ 27 MB b64
  if (input.pngBase64.length > Math.ceil((MAX_PNG_BYTES * 4) / 3)) {
    throw new Error(
      `saveNote: pngBase64 exceeds max size of ${MAX_PNG_BYTES} bytes`,
    );
  }
  // Canonical base64 shape check — Buffer.from is too permissive and
  // silently drops invalid chars, so malformed payloads could reach disk.
  if (!BASE64_RE.test(input.pngBase64)) {
    throw new Error("saveNote: pngBase64 is not canonical base64");
  }
  const pngBytes = Buffer.from(input.pngBase64, "base64");
  if (pngBytes.length === 0 || pngBytes.length > MAX_PNG_BYTES) {
    throw new Error(`saveNote: decoded PNG size out of range`);
  }
  // Verify the PNG magic bytes — cheap sanity check that this is actually
  // an image and not some other payload a misbehaving client sent.
  if (!hasPngMagic(pngBytes)) {
    throw new Error("saveNote: payload is not a PNG");
  }

  // All validation passed — safe to touch the filesystem now.
  ensureNotesDirectories();

  const id = generateNoteId();
  const metadata: NoteMetadata = {
    id,
    createdAt: new Date().toISOString(),
    url: trim(input.url, MAX_URL_LEN),
    title: trim(input.title, MAX_TITLE_LEN),
    note: trim(input.note, MAX_NOTE_TEXT_LEN),
    status: "pending",
    viewport: input.viewport,
    nearestElement: input.nearestElement,
  };

  // JSON first, PNG second: if we crash between the two, the orphaned JSON
  // is harmless and obvious; an orphaned PNG with no metadata would be
  // invisible data loss.
  atomicWriteJson(metaPath("pending", id), metadata);
  try {
    atomicWriteBytes(pngPath("pending", id), pngBytes);
  } catch (e) {
    // Roll back the metadata so we don't leave a ghost note
    try {
      unlinkSync(metaPath("pending", id));
      fsyncPath(PENDING_DIR);
    } catch {
      /* best effort */
    }
    throw e;
  }
  return metadata;
}

function readMetadata(status: NoteStatus, id: string): NoteMetadata | null {
  const path = metaPath(status, id);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as NoteMetadata;
  } catch {
    return null;
  }
}

/**
 * A note is only "real" if BOTH its JSON and PNG exist in the same directory.
 * This is the read-side half of the archive-atomicity fix: the write path
 * orders operations so any crash state leaves only an orphan metadata file,
 * and the read path filters those out. Crash recovery becomes "sweep orphans
 * asynchronously" rather than "maintain a distributed journal".
 */
function noteIsComplete(status: NoteStatus, id: string): boolean {
  if (!isValidNoteId(id)) return false;
  return existsSync(metaPath(status, id)) && existsSync(pngPath(status, id));
}

function listDir(status: NoteStatus): NoteMetadata[] {
  ensureNotesDirectories();
  const dir = dirFor(status);
  if (!existsSync(dir)) return [];
  const out: NoteMetadata[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const id = file.slice(0, -".json".length);
    // Read-side completeness filter: skip orphans left by a crash mid-archive.
    if (!noteIsComplete(status, id)) continue;
    const meta = readMetadata(status, id);
    if (meta) out.push(meta);
  }
  return out;
}

export function listNotes(
  status: NoteStatus | "all" = "pending",
): NoteMetadata[] {
  let notes: NoteMetadata[];
  if (status === "all") {
    notes = [...listDir("pending"), ...listDir("archived")];
  } else {
    notes = listDir(status);
  }
  // Newest first
  notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return notes;
}

function findNote(
  id: string,
): { status: NoteStatus; metadata: NoteMetadata } | null {
  if (!isValidNoteId(id)) return null;
  // Archive-first scan: during a crash mid-archive, the new archived copy
  // is created before the old pending metadata is unlinked (see
  // `archiveNote` below), so the archived entry is authoritative when both
  // happen to exist for a moment. Combined with `noteIsComplete`, this
  // gives a single consistent view even if orphan metadata is left around.
  for (const status of ["archived", "pending"] as NoteStatus[]) {
    if (!noteIsComplete(status, id)) continue;
    const meta = readMetadata(status, id);
    if (meta) return { status, metadata: meta };
  }
  return null;
}

export function getNote(id: string): Note | null {
  if (!isValidNoteId(id)) return null;
  const found = findNote(id);
  if (!found) return null;
  const png = pngPath(found.status, id);
  if (!existsSync(png)) return null;
  const bytes = readFileSync(png);
  return {
    metadata: found.metadata,
    pngBase64: bytes.toString("base64"),
  };
}

export function archiveNote(
  id: string,
  resolution?: string,
): NoteMetadata | null {
  if (!isValidNoteId(id)) return null;
  const found = findNote(id);
  if (!found) return null;
  if (found.status === "archived") return found.metadata;

  ensureNotesDirectories();
  const updated: NoteMetadata = {
    ...found.metadata,
    status: "archived",
    archivedAt: new Date().toISOString(),
    resolution,
  };

  // Crash-safe archive sequence, paired with `noteIsComplete` on the read
  // side. Each step leaves the note visible as exactly one of {pending,
  // archived} (or transiently invisible), never both:
  //
  //   1. write archived metadata        → archived has meta but no PNG → incomplete → invisible in archived
  //                                       pending still has both → still visible as pending ✓
  //   2. rename PNG pending → archived  → archived now complete → visible as archived ✓
  //                                       pending has meta but no PNG → invisible ✓
  //   3. unlink pending metadata        → pending fully clean ✓
  //
  // A crash between steps 1-2 leaves an orphaned archived JSON; between
  // 2-3 leaves an orphaned pending JSON. Both are cleaned up the next time
  // `sweepOrphans()` runs or on manual cleanup. Neither is visible to
  // listNotes/findNote because the completeness check filters them out.
  atomicWriteJson(metaPath("archived", id), updated);

  const oldPng = pngPath("pending", id);
  const newPng = pngPath("archived", id);
  if (existsSync(oldPng)) {
    renameSync(oldPng, newPng);
    // Cross-directory rename needs BOTH dirs fsync'd for durability:
    // the source dir loses an entry, the target dir gains one. Atomic
    // rename does not imply durable rename on POSIX.
    fsyncPath(PENDING_DIR);
    fsyncPath(ARCHIVED_DIR);
  }

  const oldMeta = metaPath("pending", id);
  if (existsSync(oldMeta)) {
    unlinkSync(oldMeta);
    fsyncPath(PENDING_DIR);
  }

  return updated;
}

export function unarchiveNote(id: string): NoteMetadata | null {
  if (!isValidNoteId(id)) return null;
  const found = findNote(id);
  if (!found) return null;
  if (found.status === "pending") return found.metadata;

  ensureNotesDirectories();
  const updated: NoteMetadata = {
    ...found.metadata,
    status: "pending",
    archivedAt: undefined,
    resolution: undefined,
  };

  // Mirror of `archiveNote`, same crash-safety reasoning:
  //   1. write pending metadata  → pending has meta but no PNG → invisible in pending
  //                                 archived still has both   → still visible as archived
  //   2. rename PNG archived → pending → pending complete, archived has meta only
  //   3. unlink archived metadata      → archived clean
  atomicWriteJson(metaPath("pending", id), updated);

  const oldPng = pngPath("archived", id);
  const newPng = pngPath("pending", id);
  if (existsSync(oldPng)) {
    renameSync(oldPng, newPng);
    // See archiveNote above — cross-dir rename needs both dirs fsync'd.
    fsyncPath(ARCHIVED_DIR);
    fsyncPath(PENDING_DIR);
  }

  const oldMeta = metaPath("archived", id);
  if (existsSync(oldMeta)) {
    unlinkSync(oldMeta);
    fsyncPath(ARCHIVED_DIR);
  }

  return updated;
}

export function deleteNote(
  id: string,
  force: boolean,
): { deleted: boolean; reason?: string } {
  if (!isValidNoteId(id)) return { deleted: false, reason: "invalid id" };
  const found = findNote(id);
  if (!found) return { deleted: false, reason: "not found" };
  if (found.status === "pending" && !force) {
    return {
      deleted: false,
      reason: "note is pending; pass force=true to delete",
    };
  }
  const png = pngPath(found.status, id);
  const meta = metaPath(found.status, id);
  // Meta first: once metadata is gone, readers treat the note as deleted
  // (no matter what lingers). Meta-then-png ordering means a crash
  // between the two leaves an orphan PNG that `sweepOrphans` cleans up.
  // Both unlinks run inside try/finally so a failure on the PNG unlink
  // doesn't skip the directory fsync — the metadata removal still needs
  // to be durable.
  try {
    if (existsSync(meta)) unlinkSync(meta);
    if (existsSync(png)) unlinkSync(png);
  } finally {
    fsyncPath(dirFor(found.status));
  }
  return { deleted: true };
}
