import { describe, expect, expectTypeOf, it } from "vitest";

import {
  TELEMETRY_EVENT_TYPES,
  type SanitizedArgumentSummary,
  type TelemetryEvent,
  type ToolStartedEvent,
} from "./types.js";

describe("telemetry event contract", () => {
  it("has one stable entry for every closed event variant", () => {
    expect(new Set(TELEMETRY_EVENT_TYPES).size).toBe(TELEMETRY_EVENT_TYPES.length);
    expect(TELEMETRY_EVENT_TYPES).toContain("tool_started");
    expect(TELEMETRY_EVENT_TYPES).toContain("telemetry_integrity");
  });

  it("accepts only sanitizer-produced argument summaries", () => {
    expectTypeOf<ToolStartedEvent["arguments"]>().toEqualTypeOf<
      SanitizedArgumentSummary | undefined
    >();
  });

  it("does not expose an arbitrary event data bag", () => {
    const unsafe: TelemetryEvent = {
      schemaVersion: 1,
      eventId: "event-1",
      runId: "run-1",
      type: "run_started",
      timestamp: "2026-07-17T00:00:00.000Z",
      monotonicOffsetMs: 0,
      processRole: "client",
      // @ts-expect-error arbitrary event payloads are forbidden
      data: { secret: "RAW_SECRET" },
    };
    expect(unsafe.type).toBe("run_started");
  });
});
