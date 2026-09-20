import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSFERS_CONFIG,
  TransferError,
  loadTransfersConfig,
  megabytesToBytes,
  readTransfersConfig,
  sanitizeTransferFilename,
  sweepTransfersRoot,
  type TransfersConfig,
} from "./retention.js";

const roots: string[] = [];
const configFiles: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mybrowser-retention-"));
  roots.push(root);
  mkdirSync(join(root, "downloads"), { recursive: true });
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
  while (configFiles.length > 0) {
    const f = configFiles.pop() as string;
    rmSync(f, { force: true });
  }
});

function land(root: string, name: string, bytes: number, ageDays = 0): string {
  const dir = join(root, "downloads", "sess");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(bytes));
  const then = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  utimesSync(path, then, then);
  return path;
}

const config = (overrides: Partial<TransfersConfig> = {}): TransfersConfig => ({
  ...DEFAULT_TRANSFERS_CONFIG,
  ...overrides,
});

describe("age-based eviction", () => {
  it("deletes payloads older than retentionDays and keeps fresh ones", () => {
    const root = makeRoot();
    const old = land(root, "old.bin", 10, 8);
    const fresh = land(root, "fresh.bin", 10, 1);
    const result = sweepTransfersRoot(root, config({ retentionDays: 7 }));
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(result.deletedFiles).toBe(1);
  });

  it("deletes the provenance sidecar along with its payload", () => {
    const root = makeRoot();
    const payload = land(root, "aged.bin", 10, 30);
    writeFileSync(`${payload}.provenance.json`, "{}\n");
    // Sidecar and payload land together: age the sidecar too (sweep ages a
    // payload by its sidecar's mtime when both exist).
    utimesSync(`${payload}.provenance.json`, new Date(Date.now() - 30 * 86_400_000), new Date(Date.now() - 30 * 86_400_000));
    const sidecarOnly = land(root, "orphan.bin.provenance.json", 10, 30);
    sweepTransfersRoot(root, config({ retentionDays: 7 }));
    expect(existsSync(payload)).toBe(false);
    expect(existsSync(`${payload}.provenance.json`)).toBe(false);
    expect(existsSync(sidecarOnly)).toBe(false);
  });
});

describe("aggregate-byte eviction", () => {
  it("enforces maxTotalMb deleting oldest first", () => {
    const root = makeRoot();
    const kib = 1024;
    const a = land(root, "a.bin", 900 * kib, 5); // oldest, biggest
    const b = land(root, "b.bin", 200 * kib, 3);
    const c = land(root, "c.bin", 50 * kib, 1); // newest
    // Total 1150 KiB > 1 MiB budget → delete oldest (a) first, then stop.
    const result = sweepTransfersRoot(root, config({ maxTotalMb: 1 }));
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(true);
    expect(existsSync(c)).toBe(true);
    expect(result.deletedFiles).toBe(1);
  });

  it("keeps everything when the aggregate is under budget", () => {
    const root = makeRoot();
    land(root, "a.bin", 100, 2);
    land(root, "b.bin", 100, 3);
    sweepTransfersRoot(root, config({ maxTotalMb: 1 }));
    expect(existsSync(join(root, "downloads", "sess", "a.bin"))).toBe(true);
    expect(existsSync(join(root, "downloads", "sess", "b.bin"))).toBe(true);
  });
});

describe("symlink refusal", () => {
  it("unlinks a symlinked download without touching its target", () => {
    const root = makeRoot();
    const victim = join(root, "victim.bin");
    writeFileSync(victim, "precious");
    const link = join(root, "downloads", "sess", "link.bin");
    mkdirSync(join(root, "downloads", "sess"), { recursive: true });
    symlinkSync(victim, link);
    utimesSync(victim, new Date(0), new Date(0)); // stale — would be evicted
    sweepTransfersRoot(root, config({ retentionDays: 7 }));
    expect(existsSync(link)).toBe(false); // unlinked as-is, never followed
    expect(readFileSync(victim, "utf8")).toBe("precious");
  });
});

describe("config validation (fail closed)", () => {
  function writeConfigFile(json: string): string {
    const path = join(tmpdir(), `mybrowser-config-${Date.now()}-${Math.random()}.json`);
    writeFileSync(path, json);
    configFiles.push(path);
    return path;
  }

  it("returns valid defaults when the config file is absent", () => {
    const cfg = loadTransfersConfig(join(tmpdir(), "definitely-missing-config.json"));
    expect(cfg).toEqual({ maxFileMb: 40, retentionDays: 7, maxTotalMb: 2048 });
  });

  it("preserves a valid transfers section", () => {
    const path = writeConfigFile(JSON.stringify({
      token: "t",
      transfers: { maxFileMb: 55, retentionDays: 14, maxTotalMb: 1024 },
    }));
    expect(loadTransfersConfig(path)).toEqual({ maxFileMb: 55, retentionDays: 14, maxTotalMb: 1024 });
  });

  it("rejects out-of-range maxFileMb", () => {
    const path = writeConfigFile(JSON.stringify({ transfers: { maxFileMb: 101 } }));
    expect(() => loadTransfersConfig(path)).toThrow(TransferError);
  });

  it("rejects out-of-range retentionDays and maxTotalMb", () => {
    const bad1 = writeConfigFile(JSON.stringify({ transfers: { retentionDays: 91 } }));
    expect(() => loadTransfersConfig(bad1)).toThrow(TransferError);
    const bad2 = writeConfigFile(JSON.stringify({ transfers: { maxTotalMb: 15 } }));
    expect(() => loadTransfersConfig(bad2)).toThrow(TransferError);
  });

  it("rejects a malformed transfers section", () => {
    const path = writeConfigFile(JSON.stringify({ transfers: "yes" }));
    expect(() => loadTransfersConfig(path)).toThrow(TransferError);
    expect(() => readTransfersConfig({ maxFileMb: 40, retentionDays: 7, maxTotalMb: 2048, extra: 1 })).toThrow(TransferError);
  });

  it("sanitizes filenames and converts megabytes", () => {
    expect(sanitizeTransferFilename("report.final.v2.pdf")).toBe("report.final.v2.pdf");
    expect(megabytesToBytes(1)).toBe(1024 * 1024);
  });
});
