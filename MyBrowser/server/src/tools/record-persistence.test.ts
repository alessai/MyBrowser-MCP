import {
  chmodSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  requirePositiveNoFollowFlag,
  saveRecordingToFile,
} from "./record.js";

const tempDirs: string[] = [];
const recording = {
  name: "No_Follow",
  startedAt: 100,
  stoppedAt: 200,
  url: "https://example.test/",
  steps: [],
  requiredVariables: [],
};

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("existing recording O_NOFOLLOW capability", () => {
  it.each([undefined, 0, -1, Number.NaN])(
    "rejects unavailable or non-positive flag %s",
    (flag) => {
      expect(() => requirePositiveNoFollowFlag(flag))
        .toThrow("RECORDING_PERSISTENCE_NOFOLLOW_UNAVAILABLE");
    },
  );

  it("accepts a positive integer flag", () => {
    expect(requirePositiveNoFollowFlag(0x2000_0000)).toBe(0x2000_0000);
  });

  it.each([undefined, 0])(
    "fails closed before opening or reading an existing path when injected flag is %s",
    (noFollowFlag) => {
      const base = mkdtempSync(join(tmpdir(), "mybrowser-nofollow-unavailable-"));
      tempDirs.push(base);
      const recordingsDir = join(base, "recordings");
      saveRecordingToFile(recording, recordingsDir);
      const open = vi.fn(openSync);
      const read = vi.fn(readFileSync);

      expect(() => saveRecordingToFile(recording, recordingsDir, {
        noFollowFlag,
        openSync: open,
        readFileSync: read as typeof readFileSync,
      })).toThrow("RECORDING_PERSISTENCE_NOFOLLOW_UNAVAILABLE");
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0]?.[1]).toBe("wx");
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("uses an injected positive flag for normal existing-file verification", () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-nofollow-positive-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    const filePath = join(recordingsDir, "No_Follow.json");
    saveRecordingToFile(recording, recordingsDir);
    chmodSync(filePath, 0o600);
    const noFollowFlag = 0x2000_0000;
    const open = vi.fn(((
      path: Parameters<typeof openSync>[0],
      flags: Parameters<typeof openSync>[1],
      mode?: Parameters<typeof openSync>[2],
    ) => openSync(
      path,
      typeof flags === "number" ? flags & ~noFollowFlag : flags,
      mode,
    )) as typeof openSync);

    expect(saveRecordingToFile(recording, recordingsDir, {
      noFollowFlag,
      openSync: open,
    })).toBe("existing-identical");
    const existingFlags = open.mock.calls[1]?.[1];
    expect(typeof existingFlags).toBe("number");
    expect((existingFlags as number) & noFollowFlag).toBe(noFollowFlag);
  });
});
