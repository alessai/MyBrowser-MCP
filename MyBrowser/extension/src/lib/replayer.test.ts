import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Recording, ReplayToken } from "./recorder";
import type { ToolContext } from "./tools";

const mocks = vi.hoisted(() => ({
  handleTool: vi.fn(),
}));

vi.mock("./tools", () => ({
  handleTool: mocks.handleTool,
}));

import { preflightReplay, replayRecording } from "./replayer";

const SECRET_ALPHA = "SECRET_REPLAY_ALPHA_9012";
const SECRET_BETA = "SECRET_REPLAY_BETA_3478";

function recording(steps: Recording["steps"]): Recording {
  return {
    name: "replay-test",
    startedAt: 1,
    stoppedAt: 2,
    url: "https://example.test/start",
    steps,
    requiredVariables: [],
  };
}

function step(
  action: string,
  args: Record<string, unknown> = {},
  timestamp = 1,
): Recording["steps"][number] {
  return {
    action,
    args,
    timestamp,
    durationMs: 0,
    url: "https://example.test/current",
  };
}

function context(tabId = 7): ToolContext {
  return {
    sessionId: "session-a",
    expiresAt: Date.now() + 60_000,
    input: {} as ToolContext["input"],
    services: {} as ToolContext["services"],
    getTabId: () => tabId,
    setTabId: vi.fn(),
    clearTab: vi.fn(),
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("replay preflight", () => {
  beforeEach(() => {
    mocks.handleTool.mockReset();
    mocks.handleTool.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    "new_tab",
    "select_tab",
    "close_tab",
    "browser_new_tab",
    "browser_select_tab",
    "browser_close_tab",
  ])("rejects unsupported action %s before placeholders or side effects", async (action) => {
    vi.useFakeTimers();
    const candidate = recording([
      step("browser_type", { text: "{{missing_name}}" }),
      step(action, { nested: "{{{malformed}}}" }, 2),
    ]);
    const beginReplay = vi.fn(() => ({} as ReplayToken));
    const endReplay = vi.fn();

    expect(() => preflightReplay(candidate, {})).toThrowError(
      "RECORDING_UNSUPPORTED_MULTI_TAB",
    );
    await expect(replayRecording({
      recording: candidate,
      variables: {},
      speed: 1,
      tabId: 7,
      beginReplay,
      endReplay,
    }, context())).rejects.toThrowError("RECORDING_UNSUPPORTED_MULTI_TAB");
    expect(mocks.handleTool).not.toHaveBeenCalled();
    expect(beginReplay).not.toHaveBeenCalled();
    expect(endReplay).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports every missing placeholder from valid step args in sorted order", async () => {
    const candidate = recording([
      step("browser_type", { text: "{{zeta}}" }),
      step("browser_assert", {
        checks: [{ value: "prefix {{alpha}}/{{zeta}}" }],
      }, 2),
      step("browser_type", { text: "{{middle}}" }, 3),
    ]);

    expect(() => preflightReplay(candidate, { middle: SECRET_ALPHA })).toThrowError(
      "REPLAY_VARIABLES_MISSING: alpha,zeta",
    );
    await expect(replayRecording({
      recording: candidate,
      variables: { middle: SECRET_ALPHA },
      startFromStep: 2,
      stopAtStep: 2,
      tabId: 7,
    }, context())).rejects.toThrowError("REPLAY_VARIABLES_MISSING: alpha,zeta");
    expect(mocks.handleTool).not.toHaveBeenCalled();
  });

  it("does not collect or substitute placeholders from recording metadata", () => {
    const candidate = recording([step("browser_go_back")]);
    candidate.name = `{{${SECRET_ALPHA}}}`;

    expect(preflightReplay(candidate, {})).toEqual([step("browser_go_back")]);
    expect(candidate.name).toBe(`{{${SECRET_ALPHA}}}`);
  });

  it("treats nested args.action as argument data rather than a tab transition", () => {
    const candidate = recording([
      step("browser_type", { text: "safe", action: "close_tab" }),
    ]);

    expect(() => preflightReplay(candidate, {})).toThrowError("RECORDING_INVALID");
  });

  it("substitutes recursively into prototype-safe clones without changing the source", () => {
    const args = {
      checks: [
        { type: "text_contains", value: "{{alpha}} + {{beta}}" },
        { type: "text_contains", value: "before {{alpha}} after" },
      ],
    };
    const candidate = recording([step("browser_assert", args)]);
    const original = structuredClone(candidate);

    const prepared = preflightReplay(candidate, {
      beta: SECRET_BETA,
      alpha: SECRET_ALPHA,
      ignored: "SECRET_UNUSED_7721",
    });

    expect(prepared).toEqual([step("browser_assert", {
      checks: [
        { type: "text_contains", value: `${SECRET_ALPHA} + ${SECRET_BETA}` },
        { type: "text_contains", value: `before ${SECRET_ALPHA} after` },
      ],
    })]);
    expect(candidate).toEqual(original);
    expect(prepared).not.toBe(candidate.steps);
    expect(prepared[0]).not.toBe(candidate.steps[0]);
    expect(prepared[0]?.args).not.toBe(candidate.steps[0]?.args);
    expect(Object.getPrototypeOf(prepared[0]?.args)).toBeNull();
    expect(Object.getPrototypeOf((prepared[0]?.args.checks as unknown[])[0])).toBeNull();
  });

  it("rejects malformed placeholders and unsafe object shapes generically", () => {
    const malformed = recording([
      step("browser_type", { text: `{{bad-name-${SECRET_ALPHA}}}` }),
    ]);
    let malformedError = "";
    try {
      preflightReplay(malformed, {});
    } catch (error) {
      malformedError = error instanceof Error ? error.message : String(error);
    }
    expect(malformedError).toBe("RECORDING_INVALID");
    expect(malformedError).not.toContain(SECRET_ALPHA);

    const unsafeArgs = Object.create({ inherited: SECRET_BETA }) as Record<string, unknown>;
    unsafeArgs.text = "safe";
    expect(() => preflightReplay(
      recording([step("browser_type", unsafeArgs)]),
      {},
    )).toThrowError("RECORDING_INVALID");
    expect(() => preflightReplay(
      recording([step("browser_go_back")]),
      [] as unknown as Record<string, string>,
    )).toThrowError("RECORDING_INVALID");
  });

  it("never navigates a partial replay with an unsubstituted source URL", async () => {
    const candidate = recording([
      step("browser_go_back"),
      step("browser_type", { text: "safe" }, 2),
    ]);
    candidate.url = "{{root_url}}";
    candidate.steps[1]!.url = "";

    await replayRecording({
      recording: candidate,
      variables: { root_url: SECRET_ALPHA },
      startFromStep: 2,
      tabId: 7,
    }, context());

    expect(mocks.handleTool).toHaveBeenCalledTimes(1);
    expect(mocks.handleTool).toHaveBeenCalledWith(
      "browser_type",
      expect.objectContaining({ text: "safe", tabId: 7 }),
      expect.anything(),
    );
  });

  it.each([
    [{ startFromStep: 0 }, "REPLAY_START_STEP_OUT_OF_BOUNDS"],
    [{ startFromStep: 3 }, "REPLAY_START_STEP_OUT_OF_BOUNDS"],
    [{ stopAtStep: 0 }, "REPLAY_STOP_STEP_OUT_OF_BOUNDS"],
    [{ stopAtStep: 3 }, "REPLAY_STOP_STEP_OUT_OF_BOUNDS"],
    [{ startFromStep: 2, stopAtStep: 1 }, "REPLAY_STEP_RANGE_INVALID"],
  ] as const)("validates replay range before execution: %o", async (range, code) => {
    vi.useFakeTimers();
    const beginReplay = vi.fn(() => ({} as ReplayToken));
    const endReplay = vi.fn();
    await expect(replayRecording({
      recording: recording([
        step("browser_go_back"),
        step("browser_go_forward", {}, 10),
      ]),
      tabId: 7,
      speed: 0,
      beginReplay,
      endReplay,
      ...range,
    }, context())).rejects.toThrowError(code);
    expect(mocks.handleTool).not.toHaveBeenCalled();
    expect(beginReplay).not.toHaveBeenCalled();
    expect(endReplay).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reuses the authorized context and clears replay suppression after failure", async () => {
    const token = {} as ReplayToken;
    const beginReplay = vi.fn(() => token);
    const endReplay = vi.fn();
    mocks.handleTool.mockImplementation(async (_action, args) => {
      expect(args).toMatchObject({ text: SECRET_ALPHA, tabId: 7 });
      throw new Error(`handler leaked ${SECRET_ALPHA}`);
    });

    const result = await replayRecording({
      recording: recording([step("browser_type", {
        text: "{{alpha}}",
        tabId: 99,
      })]),
      variables: { alpha: SECRET_ALPHA },
      tabId: 7,
      beginReplay,
      endReplay,
    }, context(7));

    expect(beginReplay).toHaveBeenCalledOnce();
    expect(endReplay).toHaveBeenCalledOnce();
    expect(endReplay).toHaveBeenCalledWith(token);
    expect(result).toMatchObject({
      status: "failed",
      failedStep: 1,
      error: "REPLAY_STEP_FAILED",
      results: [{ status: "failed", error: "REPLAY_STEP_FAILED" }],
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_ALPHA);
  });

  it("releases only its own suppression token while another tab replay remains active", async () => {
    const first = deferred();
    const second = deferred();
    const activeTokens = new Set<ReplayToken>();
    const beginReplay = vi.fn(() => {
      const token = {} as ReplayToken;
      activeTokens.add(token);
      return token;
    });
    const endReplay = vi.fn((token: ReplayToken) => {
      activeTokens.delete(token);
    });
    mocks.handleTool.mockImplementation(async (_action, args) => {
      if (args.tabId === 7) return first.promise;
      return second.promise;
    });

    const firstRun = replayRecording({
      recording: recording([step("browser_go_back")]),
      tabId: 7,
      beginReplay,
      endReplay,
    }, context(7));
    const secondRun = replayRecording({
      recording: recording([step("browser_go_forward")]),
      tabId: 8,
      beginReplay,
      endReplay,
    }, context(8));
    await vi.waitFor(() => expect(mocks.handleTool).toHaveBeenCalledTimes(2));
    expect(activeTokens.size).toBe(2);

    first.reject(new Error("FIRST_REPLAY_FAILED"));
    await firstRun;
    expect(activeTokens.size).toBe(1);

    second.resolve();
    await secondRun;
    expect(activeTokens.size).toBe(0);
    expect(beginReplay).toHaveBeenCalledTimes(2);
    expect(endReplay).toHaveBeenCalledTimes(2);
    expect(endReplay.mock.calls[0]?.[0]).not.toBe(endReplay.mock.calls[1]?.[0]);
  });

  it("rejects a mismatched or unsafe authorized tab before execution", async () => {
    for (const tabId of [0, 2_147_483_648, 9]) {
      await expect(replayRecording({
        recording: recording([step("browser_go_back")]),
        tabId,
      }, context(7))).rejects.toThrowError("REPLAY_TAB_INVALID");
    }
    expect(mocks.handleTool).not.toHaveBeenCalled();
  });
});
