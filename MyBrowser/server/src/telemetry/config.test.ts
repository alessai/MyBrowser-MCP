import { describe, expect, it } from "vitest";

import {
  DEFAULT_TELEMETRY_LIMITS,
  parseTelemetryConfig,
  resolveProcessTelemetryConfig,
  type TelemetryCliOptions,
} from "./config.js";

const HOME = "/home/tester";

function parse(cli: TelemetryCliOptions = {}) {
  return parseTelemetryConfig(cli, HOME);
}

describe("parseTelemetryConfig", () => {
  it("is disabled by default without touching filesystem state", () => {
    expect(parse()).toEqual({
      enabled: false,
      directory: `${HOME}/.mybrowser/traces`,
      retentionMs: DEFAULT_TELEMETRY_LIMITS.retentionMs,
      maxTotalBytes: DEFAULT_TELEMETRY_LIMITS.maxTotalBytes,
      maxFileBytes: DEFAULT_TELEMETRY_LIMITS.maxFileBytes,
      maxEventBytes: DEFAULT_TELEMETRY_LIMITS.maxEventBytes,
    });
  });

  it("uses explicit CLI options", () => {
    expect(parse({
      traceInternal: true,
      traceDir: "~/custom-traces",
      traceRetentionDays: 7,
      traceMaxMb: 64,
    })).toEqual({
      enabled: true,
      directory: `${HOME}/custom-traces`,
      retentionMs: 7 * 86_400_000,
      maxTotalBytes: 64 * 1024 * 1024,
      maxFileBytes: DEFAULT_TELEMETRY_LIMITS.maxFileBytes,
      maxEventBytes: DEFAULT_TELEMETRY_LIMITS.maxEventBytes,
    });
  });

  it("does not enable tracing when only tuning options are supplied", () => {
    expect(parse({
      traceDir: "relative/traces",
      traceRetentionDays: 5,
      traceMaxMb: 48,
    })).toMatchObject({ enabled: false });
  });

  it("never supplies writer configuration to a standalone hub", () => {
    expect(resolveProcessTelemetryConfig({ traceInternal: true }, true, HOME)).toBeUndefined();
    expect(resolveProcessTelemetryConfig({ traceInternal: true }, false, HOME)).toMatchObject({
      enabled: true,
    });
  });

  it.each([
    [{ traceRetentionDays: Number.NaN }, "trace retention"],
    [{ traceMaxMb: Number.POSITIVE_INFINITY }, "trace maximum"],
  ] satisfies Array<[TelemetryCliOptions, string]>) (
    "rejects invalid numeric configuration %#",
    (cli, message) => expect(() => parse(cli)).toThrow(message),
  );

  it.each([
    [0, 1],
    [1, 1],
    [90, 90],
    [91, 90],
  ])("clamps retention %d days to %d", (value, expected) => {
    expect(parse({ traceRetentionDays: value }).retentionMs).toBe(
      expected * 86_400_000,
    );
  });

  it.each([
    [15, 16],
    [16, 16],
    [2_048, 2_048],
    [2_049, 2_048],
  ])("clamps storage %d MiB to %d", (value, expected) => {
    expect(parse({ traceMaxMb: value }).maxTotalBytes).toBe(
      expected * 1024 * 1024,
    );
  });

  it("rejects NUL-containing paths", () => {
    expect(() => parse({ traceDir: "bad\0path" })).toThrow("trace directory");
  });
});
