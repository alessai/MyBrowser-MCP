import { describe, expect, it } from "vitest";

import {
  TELEMETRY_TOOL_POLICIES,
  assertTelemetryPolicyCoverage,
} from "./policies.js";

describe("telemetry tool policies", () => {
  const policyNames = Object.keys(TELEMETRY_TOOL_POLICIES);

  it("covers the configured registry exactly", () => {
    expect(() => assertTelemetryPolicyCoverage(policyNames)).not.toThrow();
  });

  it("fails closed for a registered tool without a policy", () => {
    expect(() => assertTelemetryPolicyCoverage([...policyNames, "browser_new_secret_tool"]))
      .toThrow(/missing.*browser_new_secret_tool/iu);
  });

  it("fails closed for a stale policy", () => {
    expect(() => assertTelemetryPolicyCoverage(policyNames.filter((name) => name !== "browser_type")))
      .toThrow(/stale.*browser_type/iu);
  });

  it("fails closed when a real tool schema adds an unreviewed top-level field", () => {
    expect(() => assertTelemetryPolicyCoverage([{
      name: "browser_type",
      argumentFields: [
        ...Object.keys(TELEMETRY_TOOL_POLICIES.browser_type.fields),
        "newSecretField",
      ],
    }])).toThrow(/browser_type.*missing fields.*newSecretField/iu);
  });

  it("keeps the registry and nested policies immutable", () => {
    const navigatePolicy = TELEMETRY_TOOL_POLICIES.browser_navigate;
    const actionRule = TELEMETRY_TOOL_POLICIES.browser_action.fields.steps;

    expect(Object.isFrozen(TELEMETRY_TOOL_POLICIES)).toBe(true);
    expect(Object.isFrozen(navigatePolicy)).toBe(true);
    expect(Object.isFrozen(navigatePolicy.fields)).toBe(true);
    expect(Object.isFrozen(navigatePolicy.fields.url)).toBe(true);
    expect(actionRule?.kind).toBe("action_sequence");
    if (actionRule?.kind === "action_sequence") {
      expect(Object.isFrozen(actionRule.values)).toBe(true);
    }
  });
});
