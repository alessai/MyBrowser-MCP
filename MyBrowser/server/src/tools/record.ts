import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Tool } from "./types.js";

const RECORDINGS_DIR = join(homedir(), ".mybrowser", "recordings");

function ensureRecordingsDir(): void {
  mkdirSync(RECORDINGS_DIR, { recursive: true });
}

// --- MCP Tools ---

const RecordStartArgs = z.object({
  name: z.string().describe("Name for this recording session (e.g. 'checkout_flow')"),
});

const RecordStopArgs = z.object({}).strict();

const RecordListArgs = z.object({}).strict();

export const recordStart: Tool = {
  schema: {
    name: "browser_record_start",
    description:
      "Start recording browser actions. All subsequent browser tool calls will be captured as replayable steps until recording is stopped.",
    inputSchema: zodToJsonSchema(RecordStartArgs),
  },
  handle: async (context, params) => {
    const { name } = RecordStartArgs.parse(params);
    const result = await context.sendSocketMessage("browser_record_start", { name });
    return {
      content: [{ type: "text", text: `Recording started: "${name}"` }],
    };
  },
};

export const recordStop: Tool = {
  schema: {
    name: "browser_record_stop",
    description:
      "Stop the current recording session. Returns the recorded steps and saves to both extension storage and server filesystem.",
    inputSchema: zodToJsonSchema(RecordStopArgs),
  },
  handle: async (context, params) => {
    const result = (await context.sendSocketMessage("browser_record_stop", {})) as {
      name: string;
      steps: number;
      durationMs: number;
      recording: unknown;
    };
    return {
      content: [
        {
          type: "text",
          text: `Recording "${result.name}" stopped. ${result.steps} steps captured over ${Math.round(result.durationMs / 1000)}s.`,
        },
        {
          type: "text",
          text: JSON.stringify(result.recording, null, 2),
        },
      ],
    };
  },
};

export const recordList: Tool = {
  schema: {
    name: "browser_record_list",
    description:
      "List all saved recordings from both extension storage and server filesystem.",
    inputSchema: zodToJsonSchema(RecordListArgs),
  },
  handle: async (context, params) => {
    // Get recordings from extension storage
    let extensionRecordings: string[] = [];
    try {
      const extResult = (await context.sendSocketMessage("browser_record_list", {})) as {
        recordings: string[];
      };
      extensionRecordings = extResult.recordings;
    } catch {
      // Extension may not be connected
    }

    // Get recordings from server filesystem
    let serverRecordings: string[] = [];
    try {
      ensureRecordingsDir();
      const files = readdirSync(RECORDINGS_DIR);
      serverRecordings = files
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""));
    } catch {
      // Directory may not exist yet
    }

    // Merge and deduplicate
    const allNames = [...new Set([...extensionRecordings, ...serverRecordings])].sort();

    return {
      content: [
        {
          type: "text",
          text:
            allNames.length > 0
              ? `Saved recordings (${allNames.length}):\n${allNames.map((n) => `  - ${n}`).join("\n")}`
              : "No recordings found.",
        },
      ],
    };
  },
};

// --- Server-side persistence (called via WS message, not MCP) ---

function safeName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safe || safe === "." || safe === "..") throw new Error("Invalid recording name");
  return safe;
}

export function saveRecordingToFile(recording: { name: string; [key: string]: unknown }): void {
  ensureRecordingsDir();
  const filePath = join(RECORDINGS_DIR, `${safeName(recording.name)}.json`);
  // Atomic write: write to tmp, then rename
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(recording, null, 2) + "\n");
  renameSync(tmpPath, filePath);
}

export function loadRecordingFromFile(name: string): unknown | null {
  const filePath = join(RECORDINGS_DIR, `${safeName(name)}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null; // Corrupt file
  }
}
