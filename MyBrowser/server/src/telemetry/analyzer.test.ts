import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { analyzeTelemetryEvents, analyzeTelemetryJsonlText } from "./analyzer.js";
import { analyzeTelemetryFiles } from "./analyzer.js";
import { serializeTelemetryEvent } from "./writer.js";
import type { SanitizedArgumentSummary, TelemetryErrorCategory, TelemetryEvent } from "./types.js";

const CANARY = "RAW_ANALYZER_CANARY";

function base(type: TelemetryEvent["type"], trace: string, monotonicOffsetMs: number) {
  return {
    schemaVersion: 1 as const,
    type,
    eventId: `event-${trace}-${type}`,
    runId: "run-a",
    timestamp: "2026-07-17T00:00:00.000Z",
    monotonicOffsetMs,
    sessionPseudonym: "session-pseudonym",
    traceId: `trace-${trace}`,
    rootCallId: `call-${trace}`,
  };
}

function started(trace: string, fingerprint: string, at: number, target = "target-pseudonym"): TelemetryEvent {
  return {
    ...base("tool_started", trace, at),
    type: "tool_started",
    toolName: "browser_click",
    argumentFingerprint: fingerprint,
    arguments: {
      scalar: {}, presence: [], counts: {}, pseudonyms: { target }, droppedFields: 0, truncated: false,
    } as unknown as SanitizedArgumentSummary,
  };
}

function completed(trace: string, at: number, stateChanged?: boolean): TelemetryEvent {
  return {
    ...base("tool_completed", trace, at), type: "tool_completed", toolName: "browser_click",
    durationMs: 1, status: "success", ...(stateChanged === undefined ? {} : { stateChanged }),
  };
}

function failed(trace: string, at: number, errorCategory: TelemetryErrorCategory): TelemetryEvent {
  return {
    ...base("tool_failed", trace, at), type: "tool_failed", toolName: "browser_click",
    durationMs: 1, status: "error", errorCategory,
  };
}

function feedback(call: string, label: "mistake" | "expected" | "unclear"): TelemetryEvent {
  return {
    schemaVersion: 1, type: "feedback", eventId: `feedback-${call}`, runId: "run-a",
    timestamp: "2026-07-17T00:01:00.000Z", monotonicOffsetMs: 60_000,
    targetRunId: "run-a", targetCallId: call, label,
  };
}

describe("telemetry analyzer", () => {
  it("classifies exact repeats and error retries in monotonic start order", () => {
    const events: TelemetryEvent[] = [
      started("first", "same-fingerprint", 10), failed("first", 20, "extension_tool_failed"),
      {
        schemaVersion: 1, type: "tools_listed", eventId: "canary-event", runId: "run-a",
        timestamp: "2026-07-17T00:00:00.000Z", monotonicOffsetMs: 25,
        clientName: CANARY, toolCount: 1, schemaDigest: "digest",
      },
      started("second", "same-fingerprint", 30), completed("second", 40),
    ];

    const report = analyzeTelemetryEvents(events);
    expect(report.findings).toContainEqual(expect.objectContaining({
      classification: "exact_repeat", confidence: "suspected", rootCallId: "call-second",
      argumentFingerprint: "same-fingerprint",
    }));
    expect(report.findings).toContainEqual(expect.objectContaining({
      classification: "error_retry", confidence: "confirmed", rootCallId: "call-second",
    }));
    expect(JSON.stringify(report)).not.toContain(CANARY);
  });

  it("classifies explicit no-change and stale-reference repeats", () => {
    const noChange = analyzeTelemetryEvents([
      started("u1", "same", 1), completed("u1", 2, false),
      started("u2", "same", 3), completed("u2", 4),
    ]);
    expect(noChange.findings).toContainEqual(expect.objectContaining({
      classification: "unchanged_repeat", confidence: "confirmed",
    }));

    const stale = analyzeTelemetryEvents([
      started("s1", "stale", 1, "stale-target"), failed("s1", 2, "tab_not_found"),
      started("s2", "stale", 3, "stale-target"), completed("s2", 4),
    ]);
    expect(stale.findings).toContainEqual(expect.objectContaining({
      classification: "stale_reference_repeat", confidence: "confirmed",
      argumentFingerprint: "stale",
    }));
  });

  it("requires two complete A-B cycles for oscillation", () => {
    const three = analyzeTelemetryEvents([
      started("a1", "A", 1), completed("a1", 2),
      started("b1", "B", 3), completed("b1", 4),
      started("a2", "A", 5), completed("a2", 6),
    ]);
    expect(three.findings.some((finding) => finding.classification === "oscillation")).toBe(false);

    const four = analyzeTelemetryEvents([
      started("a1", "A", 1), completed("a1", 2),
      started("b1", "B", 3), completed("b1", 4),
      started("a2", "A", 5), completed("a2", 6),
      started("b2", "B", 7), completed("b2", 8),
    ]);
    expect(four.findings).toContainEqual(expect.objectContaining({
      classification: "oscillation", confidence: "suspected", argumentFingerprint: "B",
    }));
  });

  it("distinguishes semantic repeats, timeout retries, and possible no-ops", () => {
    const semantic = analyzeTelemetryEvents([
      started("semantic-one", "fingerprint_one", 1, "same_target"), completed("semantic-one", 2),
      started("semantic-two", "fingerprint_two", 3, "same_target"), completed("semantic-two", 4),
    ]);
    expect(semantic.findings).toContainEqual(expect.objectContaining({ classification: "semantic_repeat" }));

    const timeout = analyzeTelemetryEvents([
      started("timeout-one", "same_timeout", 1), failed("timeout-one", 2, "timeout"),
      started("timeout-two", "same_timeout", 3), completed("timeout-two", 4),
    ]);
    expect(timeout.findings).toContainEqual(expect.objectContaining({ classification: "timeout_retry" }));

    const noop = analyzeTelemetryEvents([started("noop", "noop_fingerprint", 1), completed("noop", 2, false)]);
    expect(noop.findings).toContainEqual(expect.objectContaining({ classification: "possible_noop" }));
  });

  it("classifies a different successful state-changing call as recovery", () => {
    const report = analyzeTelemetryEvents([
      started("bad", "failed", 1), failed("bad", 2, "extension_tool_failed"),
      started("good", "different", 3), completed("good", 4, true),
    ]);
    expect(report.findings).toContainEqual(expect.objectContaining({
      classification: "recovery", confidence: "confirmed", rootCallId: "call-good",
    }));
  });

  it("keeps recovery context for five subsequent calls", () => {
    const report = analyzeTelemetryEvents([
      started("failed", "failed_fingerprint", 1), failed("failed", 2, "extension_tool_failed"),
      started("middle-one", "middle_one", 3), completed("middle-one", 4),
      started("middle-two", "middle_two", 5), completed("middle-two", 6),
      started("middle-three", "middle_three", 7), completed("middle-three", 8),
      started("middle-four", "middle_four", 9), completed("middle-four", 10),
      started("recovered", "recovered_fingerprint", 11), completed("recovered", 12, true),
    ]);
    expect(report.findings).toContainEqual(expect.objectContaining({
      classification: "recovery", rootCallId: "call-recovered",
    }));
  });

  it("uses start order for concurrent siblings rather than terminal order", () => {
    const report = analyzeTelemetryEvents([
      started("first", "same", 10), started("second", "same", 20),
      completed("second", 30), completed("first", 40),
    ]);
    expect(report.findings.find((finding) => finding.classification === "exact_repeat")?.rootCallId)
      .toBe("call-second");
  });
  it("applies feedback to suspected findings without mutating source events", () => {
    const events = [
      started("first", "same", 1), completed("first", 2),
      started("second", "same", 3), completed("second", 4),
      feedback("call-second", "expected"),
    ];
    const before = JSON.stringify(events);
    const report = analyzeTelemetryEvents(events);
    expect(report.findings.find((finding) => finding.classification === "exact_repeat"))
      .toEqual(expect.objectContaining({ feedbackLabel: "expected", suppressed: true }));
    expect(report.counts.exact_repeat).toBe(0);
    expect(JSON.stringify(events)).toBe(before);
  });

  it("uses mistake feedback to confirm and unclear feedback only to annotate", () => {
    const mistake = analyzeTelemetryEvents([
      started("m1", "same", 1), completed("m1", 2),
      started("m2", "same", 3), completed("m2", 4), feedback("call-m2", "mistake"),
    ]);
    expect(mistake.findings.find((finding) => finding.classification === "exact_repeat"))
      .toEqual(expect.objectContaining({ feedbackLabel: "mistake", confidence: "confirmed" }));

    const unclear = analyzeTelemetryEvents([
      started("u1", "same", 1), completed("u1", 2),
      started("u2", "same", 3), completed("u2", 4), feedback("call-u2", "unclear"),
    ]);
    expect(unclear.findings.find((finding) => finding.classification === "exact_repeat"))
      .toEqual(expect.objectContaining({ feedbackLabel: "unclear", confidence: "suspected" }));
  });

  it("treats a valid JSON object without a schema as rejected rather than a future version", () => {
    const report = analyzeTelemetryJsonlText("{\"type\":\"tool_started\"}\n");
    expect(report.diagnostics.rejectedEvents).toBe(1);
    expect(report.diagnostics.unknownSchemaVersions).toBe(0);
  });

  it("reports malformed interiors, unknown versions, collisions, and truncated finals safely", () => {
    const first = JSON.stringify(started("collision", "collision_fingerprint_a", 1));
    const collision = JSON.stringify({
      ...started("collision", "collision_fingerprint_b", 2), runId: "run-b", sessionPseudonym: "other-session",
    });
    const text = [
      first,
      "{malformed interior",
      JSON.stringify({ schemaVersion: 99, type: "tool_started" }),
      collision,
      `{"canary":"${CANARY}`,
    ].join("\n");

    const report = analyzeTelemetryJsonlText(text);
    expect(report.diagnostics).toEqual({
      malformedInteriorLines: 1,
      unknownSchemaVersions: 1,
      crossPartitionCollisions: 1,
      truncatedFinalLines: 1,
      rejectedEvents: 0,
      oversizedLines: 0,
      evictedPartitions: 0,
      evictedTraceOwners: 0,
      droppedFindings: 0,
    });
    expect(JSON.stringify(report)).not.toContain(CANARY);
  });

  it("preserves explicit extension no-change when the root terminal omits state", () => {
    const summary: TelemetryEvent = {
      ...base("extension_summary", "one", 2),
      type: "extension_summary",
      transportSpanId: "transport_span_123",
      extensionRequestPseudonym: "request_pseudonym_123",
      routeMode: "direct",
      tabChanged: false,
      pathChanged: false,
    };
    const report = analyzeTelemetryEvents([
      started("one", "fingerprint_same_123", 1), summary, completed("one", 3),
      started("two", "fingerprint_same_123", 4), completed("two", 5),
    ]);
    expect(report.findings).toContainEqual(expect.objectContaining({
      classification: "unchanged_repeat", confidence: "confirmed",
    }));
  });

  it("streams private files with run filtering and bounded oversized-line rejection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mybrowser-analyzer-"));
    const file = join(directory, "trace.jsonl");
    const first = started("file-one", "fingerprint_file_123", 1);
    const second = { ...started("file-two", "fingerprint_file_123", 2), runId: "run-b" };
    writeFileSync(file, [
      `{"oversized":"${"x".repeat(70_000)}"}`,
      serializeTelemetryEvent(first),
      serializeTelemetryEvent(second),
    ].join("\n") + "\n", { mode: 0o600 });

    const report = await analyzeTelemetryFiles([file], { runId: "run-a" });
    expect(report.diagnostics.oversizedLines).toBe(1);
    expect(report.diagnostics.rejectedEvents).toBe(0);
    expect(report.findings).toHaveLength(0);

    chmodSync(file, 0o644);
    await expect(analyzeTelemetryFiles([file])).rejects.toThrow(/0600/);
  });

  it("rejects symlinked input files without following them", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mybrowser-analyzer-link-"));
    const target = join(directory, "target.jsonl");
    const link = join(directory, "link.jsonl");
    writeFileSync(target, `${serializeTelemetryEvent(started("linked", "fingerprint_link_123", 1))}\n`, {
      mode: 0o600,
    });
    symlinkSync(target, link);
    await expect(analyzeTelemetryFiles([link])).rejects.toThrow();
  });

  it("rejects trace files reached through a symlinked ancestor", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mybrowser-analyzer-parent-"));
    const real = join(directory, "real");
    const linked = join(directory, "linked");
    const file = join(real, "trace.jsonl");
    mkdirSync(real, { mode: 0o700 });
    writeFileSync(file, `${serializeTelemetryEvent(started("ancestor", "fingerprint_ancestor", 1))}\n`, {
      mode: 0o600,
    });
    symlinkSync(real, linked);
    await expect(analyzeTelemetryFiles([join(linked, "trace.jsonl")])).rejects.toThrow(/symbolic link/);
  });

  it("keeps classifier state across rotated files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mybrowser-analyzer-segments-"));
    const first = join(directory, "first.jsonl");
    const second = join(directory, "second.jsonl");
    writeFileSync(first, [
      serializeTelemetryEvent(started("segment-one", "same_segment_fingerprint", 1)),
      serializeTelemetryEvent(completed("segment-one", 2)),
    ].join("\n") + "\n", { mode: 0o600 });
    writeFileSync(second, [
      serializeTelemetryEvent(started("segment-two", "same_segment_fingerprint", 3)),
      serializeTelemetryEvent(completed("segment-two", 4)),
    ].join("\n") + "\n", { mode: 0o600 });

    const report = await analyzeTelemetryFiles([first, second]);
    expect(report.counts.exact_repeat).toBe(1);
  });

  it("rejects prototype-injection fields at the runtime schema gate", () => {
    const valid = serializeTelemetryEvent(started("prototype", "fingerprint_prototype", 1));
    const injected = `${valid.slice(0, -1)},\"__proto__\":{\"polluted\":true}}\n`;
    const report = analyzeTelemetryJsonlText(injected);
    expect(report.diagnostics.rejectedEvents).toBe(1);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain("polluted");
  });
});
