import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context.js";
import type { IStateManager } from "../state-manager.js";
import { createRecordingTools } from "./record.js";

const directories: string[] = [];
const SECRET_LOCAL = "SECRET_RECORD_LIST_LOCAL_5284";
const SECRET_EXTENSION = "SECRET_RECORD_LIST_EXTENSION_7193";

function validRecording(name: string) {
  return {
    name,
    startedAt: 1,
    stoppedAt: 2,
    url: "https://example.test/path",
    steps: [{
      action: "browser_go_back",
      args: {},
      timestamp: 1,
      durationMs: 0,
      url: "https://example.test/path",
    }],
    requiredVariables: [],
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("recording compatibility list", () => {
  it("returns sorted structured entries without exposing local legacy values", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "mybrowser-record-list-"));
    const recordingsDir = join(rootDir, "recordings");
    mkdirSync(recordingsDir, { mode: 0o700 });
    directories.push(rootDir);
    writeFileSync(
      join(recordingsDir, "safe-local.json"),
      JSON.stringify(validRecording("safe-local")),
    );
    writeFileSync(join(recordingsDir, "action-precedence.json"), JSON.stringify({
      steps: [
        { action: 42, args: {} },
        { action: "browser_close_tab", args: { value: SECRET_LOCAL } },
      ],
    }));
    writeFileSync(
      join(recordingsDir, "canary-args.json"),
      JSON.stringify({
        ...validRecording("canary-args"),
        steps: [{
          ...validRecording("canary-args").steps[0],
          args: { secret: SECRET_LOCAL },
        }],
      }),
    );
    writeFileSync(
      join(recordingsDir, "key-mismatch.json"),
      JSON.stringify(validRecording("different-name")),
    );
    writeFileSync(join(recordingsDir, "legacy-safe.json"), JSON.stringify({
      steps: [{ action: "browser_go_back", args: {} }],
    }));
    writeFileSync(
      join(recordingsDir, "malformed-local.json"),
      `{ "steps": "${SECRET_LOCAL}"`,
    );
    const sendSocketMessage = vi.fn().mockResolvedValue({
      recordings: [
        { name: "safe-extension", compatible: true },
        {
          name: "legacy-extension",
          compatible: false,
          reason: "RECORDING_UNSUPPORTED_MULTI_TAB",
          ignored: SECRET_EXTENSION,
        },
      ],
    });
    const { recordList } = createRecordingTools(
      {} as IStateManager,
      () => "session-a",
      { recordingsDir },
    );

    const result = await recordList.handle(
      { sendSocketMessage } as unknown as Context,
      {},
    );

    expect(result.recordings).toEqual([
      {
        name: "action-precedence",
        compatible: false,
        reason: "RECORDING_UNSUPPORTED_MULTI_TAB",
      },
      { name: "canary-args", compatible: false, reason: "RECORDING_INVALID" },
      { name: "key-mismatch", compatible: false, reason: "RECORDING_INVALID" },
      {
        name: "legacy-extension",
        compatible: false,
        reason: "RECORDING_UNSUPPORTED_MULTI_TAB",
      },
      { name: "legacy-safe", compatible: false, reason: "RECORDING_INVALID" },
      { name: "malformed-local", compatible: false, reason: "RECORDING_INVALID" },
      { name: "safe-extension", compatible: true },
      { name: "safe-local", compatible: true },
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET_LOCAL);
    expect(serialized).not.toContain(SECRET_EXTENSION);
  });
});
