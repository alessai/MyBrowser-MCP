import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import {
  normalizeRecordingName,
  RECORDING_RESERVATION_LEASE_MS,
  type IStateManager,
} from "../state-manager.js";
import type { Tool } from "./types.js";

const RECORDINGS_DIR = join(homedir(), ".mybrowser", "recordings");
export { RECORDING_RESERVATION_LEASE_MS } from "../state-manager.js";

interface PrivateDirectoryOps {
  mkdirSync: typeof mkdirSync;
  chmodSync: typeof chmodSync;
  statSync: typeof statSync;
}

const PRIVATE_DIRECTORY_OPS: PrivateDirectoryOps = {
  mkdirSync,
  chmodSync,
  statSync,
};

function ensurePrivateDirectory(
  path: string,
  ops: PrivateDirectoryOps = PRIVATE_DIRECTORY_OPS,
): void {
  ops.mkdirSync(path, { recursive: true, mode: 0o700 });
  ops.chmodSync(path, 0o700);
  const stats = ops.statSync(path);
  if (!stats.isDirectory()) {
    throw new Error(`Private recording path is not a directory: ${path}`);
  }
  if ((stats.mode & 0o777) !== 0o700) {
    throw new Error(`Private recording directory must have exact mode 0700: ${path}`);
  }
}

function ensureRecordingsDir(
  recordingsDir = RECORDINGS_DIR,
  ops: PrivateDirectoryOps = PRIVATE_DIRECTORY_OPS,
): void {
  ensurePrivateDirectory(dirname(recordingsDir), ops);
  ensurePrivateDirectory(recordingsDir, ops);
}

// --- MCP Tools ---

const RecordStartArgs = z.object({
  name: z.string().trim().min(1).describe("Name for this recording session (e.g. 'checkout_flow')"),
  tabId: z.number().int().nonnegative().describe("Tab where recording starts"),
});

const RecordStopArgs = z.object({}).strict();

const RecordListArgs = z.object({}).strict();

const RecordedStepSchema = z.object({
  action: z.string().min(1),
  args: z.record(z.unknown()),
  timestamp: z.number().finite(),
  durationMs: z.number().finite().nonnegative(),
  url: z.string(),
  result: z.unknown().optional(),
});

export const RecordingSchema = z.object({
  name: z.string().min(1),
  startedAt: z.number().finite(),
  stoppedAt: z.number().finite(),
  url: z.string(),
  steps: z.array(RecordedStepSchema),
  variables: z.record(z.string()).optional(),
});

export type SanitizedRecording = z.infer<typeof RecordingSchema>;

export function sanitizeRecording(recording: unknown): SanitizedRecording {
  const parsed = RecordingSchema.parse(recording);
  return { ...parsed, name: normalizeRecordingName(parsed.name) };
}

const RecordStopResultSchema = z.object({
  extensionSaved: z.boolean().optional(),
  serverSaved: z.boolean().optional(),
  recording: RecordingSchema,
  error: z.string().optional(),
});

export function createRecordingTools(
  stateManager: IStateManager,
  getSessionId: () => string,
): { recordStart: Tool; recordStop: Tool; recordList: Tool } {
  let activeRecordingName: string | undefined;
  let failedStartCleanupPending = false;
  let pendingStop: {
    recording: SanitizedRecording;
    serverPersisted: boolean;
  } | undefined;

  const releaseActiveRecording = async (): Promise<void> => {
    const name = activeRecordingName;
    if (!name) return;

    const released = await stateManager.releaseRecordingReservation(getSessionId(), name);
    if (released) {
      if (activeRecordingName === name) {
        activeRecordingName = undefined;
        failedStartCleanupPending = false;
      }
      return;
    }

    const stillLive = await stateManager.hasRecordingReservation(getSessionId(), name);
    if (stillLive) throw new Error("Recording reservation release failed");
    if (activeRecordingName === name) {
      activeRecordingName = undefined;
      failedStartCleanupPending = false;
    }
  };

  const finishPendingStop = () => {
    if (!pendingStop) throw new Error("No completed recording is pending cleanup");
    const { recording, serverPersisted } = pendingStop;
    const persistenceStatus = serverPersisted
      ? "Server persistence acknowledged."
      : "Server persistence partial: no durable write was acknowledged.";
    const durationMs = Math.max(0, recording.stoppedAt - recording.startedAt);
    pendingStop = undefined;

    return {
      content: [
        {
          type: "text" as const,
          text: `Recording "${recording.name}" stopped. ${recording.steps.length} steps captured over ${Math.round(durationMs / 1000)}s. ${persistenceStatus}`,
        },
        {
          type: "text" as const,
          text: JSON.stringify(recording, null, 2),
        },
      ],
    };
  };

  const recordStart: Tool = {
    schema: {
      name: "browser_record_start",
      description:
        "Start recording browser actions. All subsequent browser tool calls will be captured as replayable steps until recording is stopped.",
      inputSchema: zodToJsonSchema(RecordStartArgs),
    },
    handle: async (context, params) => {
      const { name, tabId } = RecordStartArgs.parse(params);
      if (failedStartCleanupPending) await releaseActiveRecording();
      if (activeRecordingName) {
        throw new Error("A recording reservation is already active for this session");
      }
      const sessionId = getSessionId();
      const reserved = await stateManager.reserveRecording(
        sessionId,
        name,
        RECORDING_RESERVATION_LEASE_MS,
      );
      if (!reserved.ok) {
        throw new Error(`RECORDING_NAME_CONFLICT: recording name is reserved by session ${reserved.owner}`);
      }
      activeRecordingName = reserved.reservation.name;
      failedStartCleanupPending = true;

      try {
        await context.sendSocketMessage("browser_record_start", { name, tabId });
        failedStartCleanupPending = false;
      } catch (error) {
        await releaseActiveRecording();
        throw error;
      }
      return {
        content: [{ type: "text", text: `Recording started: "${reserved.reservation.name}"` }],
      };
    },
  };

  const recordStop: Tool = {
    schema: {
      name: "browser_record_stop",
      description:
        "Stop the current recording session. Returns the recorded steps and reports whether server persistence completed.",
      inputSchema: zodToJsonSchema(RecordStopArgs),
    },
    handle: async (context, params) => {
      RecordStopArgs.parse(params);
      if (failedStartCleanupPending) await releaseActiveRecording();
      const sessionId = getSessionId();
      let rawResult: unknown;
      try {
        rawResult = await context.sendSocketMessage("browser_record_stop", {});
      } catch (error) {
        await releaseActiveRecording();
        if (pendingStop) return finishPendingStop();
        throw error;
      }

      if (pendingStop) {
        await releaseActiveRecording();
        return finishPendingStop();
      }

      try {
        const result = RecordStopResultSchema.parse(rawResult);
        const recording = sanitizeRecording(result.recording);
        if (activeRecordingName && recording.name !== activeRecordingName) {
          throw new Error("Recording result does not match the active reservation");
        }

        pendingStop = { recording, serverPersisted: false };
        const reservationStillActive = activeRecordingName
          ? await stateManager.hasRecordingReservation(sessionId, activeRecordingName)
          : false;
        pendingStop.serverPersisted = result.serverSaved === true && !reservationStillActive;
        if (reservationStillActive) {
          await releaseActiveRecording();
        } else {
          activeRecordingName = undefined;
        }

        return finishPendingStop();
      } catch (error) {
        if (!pendingStop) await releaseActiveRecording();
        throw error;
      }
    },
  };

  const recordList: Tool = {
    schema: {
      name: "browser_record_list",
      description:
        "List all saved recordings from both extension storage and server filesystem.",
      inputSchema: zodToJsonSchema(RecordListArgs),
    },
    handle: async (context, params) => {
      RecordListArgs.parse(params);
      let extensionRecordings: string[] = [];
      try {
        const extResult = (await context.sendSocketMessage("browser_record_list", {})) as {
          recordings: string[];
        };
        extensionRecordings = extResult.recordings;
      } catch {
        // Extension may not be connected.
      }

      let serverRecordings: string[] = [];
      try {
        ensureRecordingsDir();
        serverRecordings = readdirSync(RECORDINGS_DIR)
          .filter((file) => file.endsWith(".json"))
          .map((file) => file.replace(/\.json$/, ""));
      } catch {
        // Directory may not exist yet.
      }

      const allNames = [...new Set([...extensionRecordings, ...serverRecordings])].sort();
      return {
        content: [{
          type: "text",
          text: allNames.length > 0
            ? `Saved recordings (${allNames.length}):\n${allNames.map((name) => `  - ${name}`).join("\n")}`
            : "No recordings found.",
        }],
      };
    },
  };

  return { recordStart, recordStop, recordList };
}

// --- Server-side persistence (called via acknowledged WS message, not MCP) ---

export function saveRecordingToFile(
  recording: unknown,
  recordingsDir = RECORDINGS_DIR,
  directoryOps: PrivateDirectoryOps = PRIVATE_DIRECTORY_OPS,
): "created" | "existing-identical" {
  const sanitized = sanitizeRecording(recording);
  ensureRecordingsDir(recordingsDir, directoryOps);
  const filePath = join(recordingsDir, `${normalizeRecordingName(sanitized.name)}.json`);
  let fd: number;
  try {
    fd = openSync(filePath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      const existing = sanitizeRecording(JSON.parse(readFileSync(filePath, "utf-8")));
      if (isDeepStrictEqual(existing, sanitized)) return "existing-identical";
    } catch {
      // Preserve the exclusive-create error for corrupt or invalid existing data.
    }
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify(sanitized, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return "created";
}

export function loadRecordingFromFile(name: string): unknown | null {
  const filePath = join(RECORDINGS_DIR, `${normalizeRecordingName(name)}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null; // Corrupt file
  }
}
