import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoSymlinkAncestors,
  discardPart,
  ensureTransfersDirTree,
  finalizeLanding,
  openPartFile,
  planLandingPath,
  readProvenance,
  requirePositiveNoFollowFlag,
  sessionDownloadDir,
  transfersDownloadsDir,
  transfersTmpDir,
} from "./landing.js";
import { TransferError, sanitizeTransferFilename } from "./retention.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mybrowser-landing-"));
  roots.push(root);
  ensureTransfersDirTree(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop() as string;
    rmSync(root, { recursive: true, force: true });
  }
});

describe("sanitizeTransferFilename", () => {
  it("accepts a plain name", () => {
    expect(sanitizeTransferFilename("report.pdf")).toBe("report.pdf");
  });

  it("rejects path traversal", () => {
    expect(() => sanitizeTransferFilename("../etc/passwd")).toThrow(TransferError);
  });

  it("rejects embedded separators", () => {
    expect(() => sanitizeTransferFilename("a/b.png")).toThrow(TransferError);
    expect(() => sanitizeTransferFilename("a\\b.png")).toThrow(TransferError);
  });

  it("rejects a leading dot", () => {
    expect(() => sanitizeTransferFilename(".env")).toThrow(TransferError);
    expect(() => sanitizeTransferFilename("..hidden")).toThrow(TransferError);
  });

  it("rejects overlength names", () => {
    expect(() => sanitizeTransferFilename(`${"a".repeat(121)}.pdf`)).toThrow(TransferError);
  });

  it("rejects non-string and empty input", () => {
    expect(() => sanitizeTransferFilename(undefined)).toThrow(TransferError);
    expect(() => sanitizeTransferFilename("")).toThrow(TransferError);
  });
});

describe("planLandingPath", () => {
  it("lands inside transfers/downloads/<sessionId>/", () => {
    const root = makeRoot();
    const planned = planLandingPath(root, "sess-1", "photo.jpg");
    expect(planned.startsWith(sessionDownloadDir(root, "sess-1") + "/")).toBe(true);
    expect(planned.endsWith("photo.jpg")).toBe(true);
  });

  it("rejects a sessionId that escapes the downloads tree", () => {
    const root = makeRoot();
    expect(() => planLandingPath(root, "../escape", "x.bin")).toThrow(TransferError);
  });
});

describe("finalizeLanding", () => {
  function stagePart(root: string, bytes: Buffer, sha256: string) {
    const part = openPartFile(root, "tf-finalize-1");
    writeSync(part.fd, bytes);
    return { part, request: {
      root,
      sessionId: "sess-final",
      filename: "data.bin",
      mimeType: "application/octet-stream",
      sha256,
      totalBytes: bytes.length,
      sourceUrl: "https://example.com/file",
      browserId: "b1",
      transferId: "tf-finalize-1",
      receivedAt: new Date(0),
    } };
  }

  it("writes provenance before payload and produces a matching sidecar", () => {
    const root = makeRoot();
    const bytes = Buffer.from("hello transfer");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const { part, request } = stagePart(root, bytes, sha256);

    const finalPath = finalizeLanding(part, request).finalPath;

    // Final landed file matches the staged bytes.
    expect(readFileSync(finalPath).equals(bytes)).toBe(true);
    expect(lstatSync(finalPath).isSymbolicLink()).toBe(false);
    // Provenance sidecar exists next to the payload with full fields.
    const provenance = readProvenance(`${finalPath}.provenance.json`);
    expect(provenance).toMatchObject({
      sourceUrl: "https://example.com/file",
      browserId: "b1",
      sessionId: "sess-final",
      transferId: "tf-finalize-1",
      sha256,
      bytes: bytes.length,
      mimeType: "application/octet-stream",
    });
    // The staged part file is gone.
    expect(existsSync(part.path)).toBe(false);
  });

  it("lands under the session directory", () => {
    const root = makeRoot();
    const bytes = Buffer.from("x");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const { part, request } = stagePart(root, bytes, sha256);
    const { finalPath } = finalizeLanding(part, request);
    expect(finalPath.startsWith(sessionDownloadDir(root, "sess-final") + "/")).toBe(true);
  });
});

describe("symlink hardening", () => {
  it("discardPart refuses symlinked part files", () => {
    const root = makeRoot();
    const victim = join(root, "victim.txt");
    writeFileSync(victim, "keep me");
    const tmp = transfersTmpDir(root);
    symlinkSync(victim, join(tmp, "tf-symlink-1.part"));
    discardPart(root, "tf-symlink-1");
    // Fail-closed: the symlink target survives.
    expect(readFileSync(victim, "utf8")).toBe("keep me");
  });

  it("assertNoSymlinkAncestors rejects a symlinked session dir", () => {
    const root = makeRoot();
    const outside = mkdtempSync(join(tmpdir(), "mybrowser-outside-"));
    roots.push(outside);
    const sessionDir = sessionDownloadDir(root, "sess-link");
    mkdirSync(sessionDir, { recursive: true });
    rmdirSync(sessionDir);
    symlinkSync(outside, sessionDir);
    expect(() => assertNoSymlinkAncestors(join(sessionDir, "f.bin"))).toThrow(TransferError);
    expect(existsSync(join(outside, "f.bin"))).toBe(false);
  });

  it("requirePositiveNoFollowFlag rejects flags missing O_NOFOLLOW", () => {
    expect(() => requirePositiveNoFollowFlag(0)).toThrow(TransferError);
    expect(() => requirePositiveNoFollowFlag(undefined)).toThrow(TransferError);
  });
});
