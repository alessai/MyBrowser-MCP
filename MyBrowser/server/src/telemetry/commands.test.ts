import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { describe, expect, it } from "vitest";

import {
  analyzeTraceDirectory,
  annotateTrace,
  exportTraces,
  listTraceRuns,
  purgeTraces,
  registerTraceCommands,
} from "./commands.js";
import { serializeTelemetryEvent } from "./writer.js";
import type { SanitizedArgumentSummary, TelemetryConfig, TelemetryEvent } from "./types.js";

const CANARY = "RAW_COMMAND_CANARY";

function configFixture(): TelemetryConfig {
  const root = mkdtempSync(join(tmpdir(), "mybrowser-trace-command-"));
  const directory = join(root, "traces");
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  const keyPath = join(root, "trace-key");
  writeFileSync(keyPath, Buffer.alloc(32, 7), { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  return {
    enabled: false,
    directory,
    keyPath,
    retentionMs: 14 * 86_400_000,
    maxTotalBytes: 16 * 1024 * 1024,
    maxFileBytes: 4 * 1024 * 1024,
    maxEventBytes: 16 * 1024,
  };
}

function correlatedBase(type: TelemetryEvent["type"], trace: string, offset: number) {
  return {
    schemaVersion: 1 as const,
    type,
    eventId: `event_${trace}_${type}_${offset}`,
    runId: "run_a",
    timestamp: "2026-07-17T00:00:00.000Z",
    monotonicOffsetMs: offset,
    sessionPseudonym: "session_pseudonym",
    traceId: `trace_${trace}`,
    rootCallId: `call_${trace}`,
  };
}

function started(trace: string, offset: number): TelemetryEvent {
  return {
    ...correlatedBase("tool_started", trace, offset),
    type: "tool_started",
    toolName: "browser_click",
    argumentFingerprint: "argument_fingerprint",
    arguments: {
      scalar: {}, presence: [], counts: {}, pseudonyms: {}, droppedFields: 0, truncated: false,
    } as unknown as SanitizedArgumentSummary,
  };
}

function completed(trace: string, offset: number): TelemetryEvent {
  return {
    ...correlatedBase("tool_completed", trace, offset),
    type: "tool_completed",
    toolName: "browser_click",
    durationMs: 1,
    status: "success",
  };
}

function writeTrace(config: TelemetryConfig): string {
  const path = join(config.directory, "trace-20260717-run_a-0001.jsonl");
  const events = [started("one", 1), completed("one", 2), started("two", 3), completed("two", 4)];
  writeFileSync(path, `${events.map(serializeTelemetryEvent).join("\n")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

describe("private trace commands", () => {
  it("lists and analyzes traces through a local-only Commander subcommand", async () => {
    const config = configFixture();
    writeTrace(config);

    expect(listTraceRuns(config)).toEqual([{ runId: "run_a", segments: 1, sizeBucket: "1-4KiB" }]);
    const report = await analyzeTraceDirectory(config, "run_a");
    expect(report.counts.exact_repeat).toBe(1);

    const output: string[] = [];
    const program = new Command().name("test");
    registerTraceCommands(program, {
      config: () => config,
      stdout: (text) => output.push(text),
    });
    await program.parseAsync(["node", "test", "trace", "analyze", "--run", "run_a", "--json"]);
    expect(JSON.parse(output.join(""))).toEqual(expect.objectContaining({ schemaVersion: 1 }));
    expect(program.commands.find((command) => command.name() === "trace")).toBeDefined();
  });

  it("writes separate private feedback and never persists raw notes", () => {
    const config = configFixture();
    const source = writeTrace(config);
    const sourceBefore = readFileSync(source, "utf8");

    const safe = annotateTrace(config, {
      runId: "run_a",
      callId: "call_two",
      label: "expected",
      note: "operator confirmed the retry",
    }, { now: () => Date.parse("2026-07-17T01:00:00.000Z"), randomUUID: () => "feedback_safe" });
    expect(safe.noteStored).toBe(true);

    const secret = annotateTrace(config, {
      runId: "run_a",
      callId: "call_two",
      label: "mistake",
      note: `token=${CANARY}`,
    }, { now: () => Date.parse("2026-07-17T01:01:00.000Z"), randomUUID: () => "feedback_secret" });
    expect(secret.noteStored).toBe(false);
    expect(readFileSync(source, "utf8")).toBe(sourceBefore);

    const feedbackFiles = readdirSync(config.directory).filter((name) => name.startsWith("feedback-"));
    expect(feedbackFiles).toHaveLength(2);
    for (const name of feedbackFiles) {
      const path = join(config.directory, name);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8")).not.toContain(CANARY);
      JSON.parse(readFileSync(path, "utf8"));
    }
  });

  it("exports only canonical events to a private no-overwrite file", async () => {
    const config = configFixture();
    writeTrace(config);
    const output = join(config.directory, "export.jsonl");

    expect(await exportTraces(config, { output, runId: "run_a" })).toBe(4);
    expect(lstatSync(output).mode & 0o777).toBe(0o600);
    for (const line of readFileSync(output, "utf8").trim().split("\n")) {
      expect(JSON.parse(line)).toEqual(expect.objectContaining({ schemaVersion: 1, runId: "run_a" }));
    }
    await expect(exportTraces(config, { output, runId: "run_a" })).rejects.toThrow();

    const symlinkOutput = join(config.directory, "symlink-export.jsonl");
    symlinkSync(output, symlinkOutput);
    await expect(exportTraces(config, { output: symlinkOutput })).rejects.toThrow();
  });

  it("rejects export paths with a symlinked parent", async () => {
    const config = configFixture();
    writeTrace(config);
    const realParent = join(config.directory, "..", "real-export-parent");
    mkdirSync(realParent, { mode: 0o700 });
    const linkedParent = join(config.directory, "..", "linked-export-parent");
    symlinkSync(realParent, linkedParent);
    const output = join(linkedParent, "export.jsonl");

    await expect(exportTraces(config, { output })).rejects.toThrow(/symbolic link/);
    expect(existsSync(join(realParent, "export.jsonl"))).toBe(false);
  });

  it("publishes no export when a source line fails the runtime schema gate", async () => {
    const config = configFixture();
    writeTrace(config);
    const malformed = join(config.directory, "trace-20260717-run_a-0002.jsonl");
    writeFileSync(malformed, "{\"schemaVersion\":1,\"rawSecret\":\"RAW_COMMAND_CANARY\"}\n", { mode: 0o600 });
    const output = join(config.directory, "rejected-export.jsonl");

    await expect(exportTraces(config, { output })).rejects.toThrow(/invalid source events/);
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(config.directory).some((name) => name.includes("rejected-export") && name.endsWith(".tmp")))
      .toBe(false);
  });

  it("rejects symlink candidates before purge and stays inside the trace directory", () => {
    const config = configFixture();
    const trace = writeTrace(config);
    const outside = join(config.directory, "..", "outside.jsonl");
    writeFileSync(outside, "outside", { mode: 0o600 });
    const symlink = join(config.directory, "trace-20260717-linked-0002.jsonl");
    symlinkSync(outside, symlink);
    const old = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(trace, old, old);

    expect(() => purgeTraces(config, { olderThanDays: 1, now: Date.parse("2026-07-17T00:00:00.000Z") }))
      .toThrow();
    expect(readFileSync(outside, "utf8")).toBe("outside");
    unlinkSync(symlink);
    expect(purgeTraces(config, { olderThanDays: 1, now: Date.parse("2026-07-17T00:00:00.000Z") }))
      .toBe(1);
    expect(readFileSync(outside, "utf8")).toBe("outside");
  });

  it("uses configured retention by default and rejects invalid annotation targets", () => {
    const config = configFixture();
    const trace = writeTrace(config);
    const old = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(trace, old, old);
    expect(purgeTraces(config, { now: Date.parse("2026-07-17T00:00:00.000Z") })).toBe(1);
    expect(() => annotateTrace(config, {
      runId: "../escape", callId: "call", label: "mistake",
    })).toThrow(/target is invalid/);
  });
});
