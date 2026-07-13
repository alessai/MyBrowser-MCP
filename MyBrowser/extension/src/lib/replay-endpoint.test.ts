import { afterEach, describe, expect, it, vi } from "vitest";

import type { Recording } from "./recorder";
import { handleTool, type ToolContext } from "./tools";

const ACTION_CANARY = "SECRET_REPLAY_ACTION_4821";
const VARIABLE_CANARY = "SECRET_REPLAY_VARIABLE_7953";

function recordingWithAction(action: unknown, args: Record<string, unknown> = {}): Recording {
  return {
    name: "endpoint-test",
    startedAt: 1,
    stoppedAt: 2,
    url: "https://example.test/start",
    steps: [{
      action,
      args,
      timestamp: 1,
      durationMs: 0,
      url: "https://example.test/current",
    }],
    requiredVariables: [],
  } as unknown as Recording;
}

function effectTrackingContext() {
  const getTabId = vi.fn(() => 7);
  const setTabId = vi.fn();
  const clearTab = vi.fn();
  const context: ToolContext = {
    sessionId: "session-a",
    expiresAt: Date.now() + 60_000,
    input: {} as ToolContext["input"],
    services: {} as ToolContext["services"],
    getTabId,
    setTabId,
    clearTab,
  };
  return { context, getTabId, setTabId, clearTab };
}

describe("browser_replay endpoint action privacy", () => {
  const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

  afterEach(() => {
    for (const spy of consoleSpies.splice(0)) spy.mockRestore();
  });

  it.each([
    {
      label: "supplied placeholder",
      action: `{{${ACTION_CANARY}}}`,
      variables: { [ACTION_CANARY]: VARIABLE_CANARY },
    },
    {
      label: "missing placeholder",
      action: `{{${ACTION_CANARY}}}`,
      variables: {},
    },
    {
      label: "unknown",
      action: `browser_${ACTION_CANARY}`,
      variables: { unused: VARIABLE_CANARY },
    },
    {
      label: "malformed",
      action: { value: ACTION_CANARY },
      variables: { unused: VARIABLE_CANARY },
    },
  ])("rejects a $label action generically without effects or disclosure", async ({
    action,
    variables,
  }) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    consoleSpies.push(errorSpy, warnSpy, logSpy);
    const { context, getTabId, setTabId, clearTab } = effectTrackingContext();

    let message = "";
    try {
      await handleTool("browser_replay", {
        recording: recordingWithAction(action),
        tabId: 7,
        variables,
      }, context);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("RECORDING_INVALID");
    expect(getTabId).not.toHaveBeenCalled();
    expect(setTabId).not.toHaveBeenCalled();
    expect(clearTab).not.toHaveBeenCalled();
    const observable = JSON.stringify({
      message,
      errors: errorSpy.mock.calls,
      warnings: warnSpy.mock.calls,
      logs: logSpy.mock.calls,
    });
    expect(observable).not.toContain(ACTION_CANARY);
    expect(observable).not.toContain(VARIABLE_CANARY);
  });

  it("reports all missing variables from valid args in sorted order", async () => {
    const { context, getTabId } = effectTrackingContext();

    await expect(handleTool("browser_replay", {
      recording: recordingWithAction("browser_type", {
        text: "{{zeta}}/{{alpha}}",
      }),
      tabId: 7,
      variables: {},
    }, context)).rejects.toThrowError("REPLAY_VARIABLES_MISSING: alpha,zeta");
    expect(getTabId).not.toHaveBeenCalled();
  });
});
