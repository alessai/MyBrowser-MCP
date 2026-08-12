import { describe, expect, it, vi } from "vitest";

import {
  CHROME_120_MINIMUM_PERIODIC_ALARM_MINUTES,
  GLOBAL_KEEPALIVE_ALARM_CONFIG,
  runGlobalKeepalive,
} from "./keepalive-policy";

describe("global keepalive alarm policy", () => {
  it("uses at least the Chrome 120+ minimum periodic alarm interval", () => {
    expect(CHROME_120_MINIMUM_PERIODIC_ALARM_MINUTES).toBe(0.5);
    expect(GLOBAL_KEEPALIVE_ALARM_CONFIG.periodInMinutes)
      .toBeGreaterThanOrEqual(CHROME_120_MINIMUM_PERIODIC_ALARM_MINUTES);
    expect(GLOBAL_KEEPALIVE_ALARM_CONFIG.periodInMinutes).toBe(0.5);
  });

  it("retries temporary-tab cleanup without skipping later keepalive work", async () => {
    const calls: string[] = [];
    const actions = {
      retryTemporaryTabCleanup: vi.fn(async () => {
        calls.push("tabs");
        throw new Error("temporary failure");
      }),
      retryRecordingCleanup: vi.fn(async () => { calls.push("recordings"); }),
      ensureAlive: vi.fn(async () => { calls.push("alive"); }),
      reportTemporaryTabFailure: vi.fn(() => { calls.push("tab-failure"); }),
      reportRecordingFailure: vi.fn(),
    };

    await expect(runGlobalKeepalive(actions)).resolves.toBeUndefined();

    expect(calls).toEqual(["tabs", "tab-failure", "recordings", "alive"]);
    expect(actions.reportRecordingFailure).not.toHaveBeenCalled();
  });
});
