import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "./types.js";
import { loadRecordingFromFile } from "./record.js";

const ReplayArgs = z.object({
  name: z.string().describe("Name of the recording to replay"),
  variables: z
    .record(z.string())
    .optional()
    .describe("Variable overrides for parameterized replay"),
  speed: z
    .number()
    .optional()
    .default(0)
    .describe(
      "Replay speed multiplier. 0 = fastest, 1 = original timing, 2 = 2x speed"
    ),
  stopOnError: z.boolean().optional().default(true),
  startFromStep: z
    .number()
    .optional()
    .describe("Start replay from this step number (1-based, for debugging)"),
  stopAtStep: z
    .number()
    .optional()
    .describe(
      "Stop replay at this step number (for time-travel debugging)"
    ),
});

export const replay: Tool = {
  schema: {
    name: "browser_replay",
    description:
      "Replay a previously recorded browser session. Supports variable substitution for parameterized replay, speed control, and step range selection for debugging.",
    inputSchema: zodToJsonSchema(ReplayArgs),
  },
  handle: async (context, params) => {
    const args = ReplayArgs.parse(params);

    // Try loading from server filesystem first
    let recording = loadRecordingFromFile(args.name) as Record<
      string,
      unknown
    > | null;

    // If not found on server, request from extension storage
    if (!recording) {
      try {
        recording = (await context.sendSocketMessage("loadRecording", {
          name: args.name,
        })) as Record<string, unknown>;
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: `Recording "${args.name}" not found on server or in extension storage.`,
            },
          ],
          isError: true,
        };
      }
    }

    // Send replay command to extension
    const result = (await context.sendSocketMessage(
      "browser_replay",
      {
        recording,
        variables: args.variables,
        speed: args.speed,
        stopOnError: args.stopOnError,
        startFromStep: args.startFromStep,
        stopAtStep: args.stopAtStep,
      },
      { timeoutMs: 300_000 },
    )) as {
      status: string;
      stepsCompleted: number;
      totalSteps: number;
      results: unknown[];
      failedStep?: number;
      error?: string;
    };

    const summary = [
      `Replay "${args.name}": ${result.status}`,
      `Steps: ${result.stepsCompleted}/${result.totalSteps} completed`,
    ];
    if (result.error) summary.push(`Error: ${result.error}`);
    if (args.variables && Object.keys(args.variables).length > 0) {
      summary.push(
        `Variables: ${Object.entries(args.variables)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")}`
      );
    }

    return {
      content: [
        { type: "text" as const, text: summary.join("\n") },
        {
          type: "text" as const,
          text: JSON.stringify(result.results, null, 2),
        },
      ],
    };
  },
};
