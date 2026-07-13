import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context.js";

const mocks = vi.hoisted(() => ({
  loadRecordingFromFile: vi.fn(),
}));

vi.mock("./record.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./record.js")>(),
  loadRecordingFromFile: mocks.loadRecordingFromFile,
}));

import { redactReplayArguments, replay } from "./replay.js";

const SECRET_NAVIGATION = "https://example.test/private?token=SECRET_REPLAY_SERVER_9012";
const SECRET_INPUT = "SECRET_REPLAY_SERVER_3478";
const SECRET_SCOPE = "SECRET_REPLAY_ACTION_SCOPE_6428";

function validRecording() {
  return {
    name: "replay-test",
    startedAt: 1,
    stoppedAt: 3,
    url: "https://example.test/start",
    steps: [
      {
        action: "browser_navigate",
        args: { url: "{{navigation_1}}" },
        timestamp: 1,
        durationMs: 0,
        url: "https://example.test/start",
      },
      {
        action: "browser_type",
        args: { text: "{{input_2}}" },
        timestamp: 2,
        durationMs: 0,
        url: "https://example.test/form",
      },
    ],
    requiredVariables: [
      { name: "navigation_1", source: "navigation", hint: "navigation_input_1" },
      { name: "input_2", source: "text", hint: "text_input_2" },
    ],
  };
}

function context(sendSocketMessage = vi.fn()): Context {
  return { sendSocketMessage } as unknown as Context;
}

describe("server replay preflight", () => {
  beforeEach(() => {
    mocks.loadRecordingFromFile.mockReset();
    mocks.loadRecordingFromFile.mockReturnValue(validRecording());
  });

  it("requires one Chrome-safe integer tab before loading or proxying", async () => {
    for (const tabId of [undefined, 0, 1.5, 2_147_483_648]) {
      const sendSocketMessage = vi.fn();
      await expect(replay.handle(context(sendSocketMessage), {
        name: "replay-test",
        ...(tabId === undefined ? {} : { tabId }),
      })).rejects.toThrow();
      expect(sendSocketMessage).not.toHaveBeenCalled();
      mocks.loadRecordingFromFile.mockClear();
    }
  });

  it.each([
    "new_tab",
    "select_tab",
    "close_tab",
    "browser_new_tab",
    "browser_select_tab",
    "browser_close_tab",
  ])("rejects unsupported legacy action %s before strict validation or proxying", async (action) => {
    mocks.loadRecordingFromFile.mockReturnValue({
      steps: [
        { action: "browser_type", args: { text: "{{missing_name}}" } },
        { action, args: { secret: SECRET_INPUT } },
      ],
    });
    const sendSocketMessage = vi.fn();

    await expect(replay.handle(context(sendSocketMessage), {
      name: "legacy",
      tabId: 7,
      variables: {},
    })).rejects.toThrow("RECORDING_UNSUPPORTED_MULTI_TAB");
    expect(sendSocketMessage).not.toHaveBeenCalled();
  });

  it("reports every missing variable name in sorted order before proxying", async () => {
    const sendSocketMessage = vi.fn();

    await expect(replay.handle(context(sendSocketMessage), {
      name: "replay-test",
      tabId: 7,
      variables: {},
      startFromStep: 2,
      stopAtStep: 2,
    })).rejects.toThrow("REPLAY_VARIABLES_MISSING: input_2,navigation_1");
    expect(sendSocketMessage).not.toHaveBeenCalled();
  });

  it.each(["supplied", "missing"])(
    "rejects a %s action placeholder generically without canary disclosure",
    async (variableState) => {
      const candidate = validRecording();
      candidate.steps[0]!.action = `{{${SECRET_SCOPE}}}`;
      mocks.loadRecordingFromFile.mockReturnValue(candidate);
      const sendSocketMessage = vi.fn();
      let message = "";

      try {
        await replay.handle(context(sendSocketMessage), {
          name: "replay-test",
          tabId: 7,
          variables: variableState === "supplied"
            ? { [SECRET_SCOPE]: SECRET_INPUT, input_2: SECRET_INPUT }
            : {},
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toBe("RECORDING_INVALID");
      expect(JSON.stringify({ message, calls: sendSocketMessage.mock.calls }))
        .not.toContain(SECRET_SCOPE);
      expect(sendSocketMessage).not.toHaveBeenCalled();
    },
  );

  it("does not interpret nested args.action as a tab transition", async () => {
    const candidate = validRecording();
    (candidate.steps[1] as { args: Record<string, unknown> }).args = {
      text: "{{input_2}}",
      action: "close_tab",
    };
    mocks.loadRecordingFromFile.mockReturnValue(candidate);
    const sendSocketMessage = vi.fn();

    await expect(replay.handle(context(sendSocketMessage), {
      name: "replay-test",
      tabId: 7,
      variables: { navigation_1: SECRET_NAVIGATION, input_2: SECRET_INPUT },
    })).rejects.toThrowError("RECORDING_INVALID");
    expect(sendSocketMessage).not.toHaveBeenCalled();
  });

  it("does not report placeholders from recording metadata as missing variables", async () => {
    const candidate = validRecording();
    candidate.name = `{{${SECRET_SCOPE}}}`;
    mocks.loadRecordingFromFile.mockReturnValue(candidate);
    const sendSocketMessage = vi.fn();
    let message = "";

    try {
      await replay.handle(context(sendSocketMessage), {
        name: "replay-test",
        tabId: 7,
        variables: { navigation_1: SECRET_NAVIGATION, input_2: SECRET_INPUT },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("RECORDING_INVALID");
    expect(message).not.toContain(SECRET_SCOPE);
    expect(sendSocketMessage).not.toHaveBeenCalled();
  });

  it("preserves stable incompatibility from extension-only legacy loading", async () => {
    mocks.loadRecordingFromFile.mockReturnValue(null);
    const sendSocketMessage = vi.fn().mockRejectedValue(
      new Error("RECORDING_UNSUPPORTED_MULTI_TAB"),
    );

    await expect(replay.handle(context(sendSocketMessage), {
      name: "legacy-tabs",
      tabId: 7,
    })).rejects.toThrowError("RECORDING_UNSUPPORTED_MULTI_TAB");
    expect(sendSocketMessage).toHaveBeenCalledTimes(1);
    expect(sendSocketMessage).toHaveBeenCalledWith("loadRecording", { name: "legacy-tabs" });
  });

  it.each([
    [{ startFromStep: 0 }, "REPLAY_START_STEP_OUT_OF_BOUNDS"],
    [{ startFromStep: 3 }, "REPLAY_START_STEP_OUT_OF_BOUNDS"],
    [{ stopAtStep: 0 }, "REPLAY_STOP_STEP_OUT_OF_BOUNDS"],
    [{ stopAtStep: 3 }, "REPLAY_STOP_STEP_OUT_OF_BOUNDS"],
    [{ startFromStep: 2, stopAtStep: 1 }, "REPLAY_STEP_RANGE_INVALID"],
  ] as const)("validates range before extension replay: %o", async (range, code) => {
    const sendSocketMessage = vi.fn();
    await expect(replay.handle(context(sendSocketMessage), {
      name: "replay-test",
      tabId: 7,
      variables: {
        navigation_1: SECRET_NAVIGATION,
        input_2: SECRET_INPUT,
      },
      ...range,
    })).rejects.toThrow(code);
    expect(sendSocketMessage).not.toHaveBeenCalled();
  });

  it("forwards the authorized tab but returns only sorted variable names", async () => {
    const sendSocketMessage = vi.fn().mockResolvedValue({
      status: "completed",
      stepsCompleted: 2,
      totalSteps: 2,
      results: [],
    });

    const result = await replay.handle(context(sendSocketMessage), {
      name: "replay-test",
      tabId: 7,
      variables: {
        navigation_1: SECRET_NAVIGATION,
        input_2: SECRET_INPUT,
      },
    });

    expect(sendSocketMessage).toHaveBeenCalledWith("browser_replay", expect.objectContaining({
      tabId: 7,
      recording: expect.objectContaining({ name: "replay-test" }),
      variables: {
        navigation_1: SECRET_NAVIGATION,
        input_2: SECRET_INPUT,
      },
    }), { timeoutMs: 300_000 });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("Variables: input_2, navigation_1");
    expect(serialized).not.toContain(SECRET_NAVIGATION);
    expect(serialized).not.toContain(SECRET_INPUT);
  });

  it("does not trust extension result strings or errors", async () => {
    const sendSocketMessage = vi.fn().mockResolvedValue({
      status: "failed",
      stepsCompleted: 0,
      totalSteps: 2,
      failedStep: 1,
      error: SECRET_NAVIGATION,
      results: [{
        step: 1,
        action: SECRET_INPUT,
        status: "failed",
        error: SECRET_NAVIGATION,
      }],
    });

    const result = await replay.handle(context(sendSocketMessage), {
      name: "replay-test",
      tabId: 7,
      variables: {
        navigation_1: SECRET_NAVIGATION,
        input_2: SECRET_INPUT,
      },
    });

    const serialized = JSON.stringify(result);
    expect(serialized).toContain("browser_navigate");
    expect(serialized).not.toContain(SECRET_NAVIGATION);
    expect(serialized).not.toContain(SECRET_INPUT);
  });

  it("normalizes malformed extension results to a stable error", async () => {
    const sendSocketMessage = vi.fn().mockResolvedValue({
      status: SECRET_INPUT,
      stepsCompleted: 0,
      totalSteps: 2,
      results: [],
    });

    await expect(replay.handle(context(sendSocketMessage), {
      name: "replay-test",
      tabId: 7,
      variables: {
        navigation_1: SECRET_NAVIGATION,
        input_2: SECRET_INPUT,
      },
    })).rejects.toThrowError("REPLAY_FAILED");
  });

  it("redacts runtime variable values from diagnostics without retaining aliases", () => {
    const redacted = redactReplayArguments({
      name: "replay-test",
      tabId: 7,
      speed: 2,
      variables: { zeta: SECRET_INPUT, alpha: SECRET_NAVIGATION },
    });
    expect(redacted).toEqual({
      name: "replay-test",
      tabId: 7,
      speed: 2,
      variableNames: ["alpha", "zeta"],
    });
    expect(JSON.stringify(redacted)).not.toContain("SECRET_REPLAY_SERVER");
  });

  it("normalizes malformed recording failures without exposing values", async () => {
    const unsafe = Object.create({ inherited: SECRET_INPUT }) as Record<string, unknown>;
    unsafe.steps = validRecording().steps;
    mocks.loadRecordingFromFile.mockReturnValue(unsafe);
    const sendSocketMessage = vi.fn();
    let message = "";
    try {
      await replay.handle(context(sendSocketMessage), {
        name: "replay-test",
        tabId: 7,
        variables: {
          navigation_1: SECRET_NAVIGATION,
          input_2: SECRET_INPUT,
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("RECORDING_INVALID");
    expect(message).not.toContain(SECRET_INPUT);
    expect(sendSocketMessage).not.toHaveBeenCalled();
  });
});
