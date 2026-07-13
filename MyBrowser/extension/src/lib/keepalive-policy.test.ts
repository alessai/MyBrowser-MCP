import { describe, expect, it } from "vitest";

import {
  CHROME_120_MINIMUM_PERIODIC_ALARM_MINUTES,
  GLOBAL_KEEPALIVE_ALARM_CONFIG,
} from "./keepalive-policy";

describe("global keepalive alarm policy", () => {
  it("uses at least the Chrome 120+ minimum periodic alarm interval", () => {
    expect(CHROME_120_MINIMUM_PERIODIC_ALARM_MINUTES).toBe(0.5);
    expect(GLOBAL_KEEPALIVE_ALARM_CONFIG.periodInMinutes)
      .toBeGreaterThanOrEqual(CHROME_120_MINIMUM_PERIODIC_ALARM_MINUTES);
    expect(GLOBAL_KEEPALIVE_ALARM_CONFIG.periodInMinutes).toBe(0.5);
  });
});
