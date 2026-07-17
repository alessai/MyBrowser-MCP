import { describe, expect, it, vi } from "vitest";

import type { TraceContextV1 } from "./protocol";
import {
  createExtensionTelemetrySummaryBuilder,
  createOffscreenToolFrame,
  readOffscreenToolFrame,
  telemetryErrorCategory,
} from "./telemetry-summary";

const TRACE: TraceContextV1 = {
  schemaVersion: 1,
  traceId: "trace_1234567890abcdef",
  rootCallId: "root_1234567890abcdefg",
  transportSpanId: "span_1234567890abcdefg",
};

describe("extension telemetry summary", () => {
  it("builds only bounded timing, correlation, tab, state, and error metadata", () => {
    let mono = 100;
    const builder = createExtensionTelemetrySummaryBuilder({
      trace: TRACE,
      extensionRequestId: "hub_1",
      timeoutMs: 100,
      offscreenReceivedAtEpochMs: 990,
      backgroundReceivedAtEpochMs: 1_000,
      monotonicNow: () => mono,
    });
    expect(builder).toBeDefined();

    builder!.markQueueEnqueued(1_000);
    builder!.markQueueStarted(1_020);
    builder!.markHandlerStarted();
    mono = 135;
    builder!.markHandlerFinished();
    builder!.setResolvedTabId(7);
    builder!.markStateSignal("tabChanged");

    expect(builder!.build("request_expired")).toEqual({
      schemaVersion: 1,
      traceId: TRACE.traceId,
      transportSpanId: TRACE.transportSpanId,
      extensionRequestId: "hub_1",
      offscreenReceivedToBackgroundMs: 10,
      queueWaitMs: 20,
      handlerMs: 35,
      resolvedTabId: 7,
      stateSignals: { tabChanged: true },
      errorCategory: "request_expired",
    });
  });

  it("omits impossible measurements and clamps elapsed time to timeout plus allowance", () => {
    let mono = 500;
    const builder = createExtensionTelemetrySummaryBuilder({
      trace: TRACE,
      extensionRequestId: "direct_request_123",
      timeoutMs: 100,
      offscreenReceivedAtEpochMs: 2_000,
      backgroundReceivedAtEpochMs: 1_000,
      monotonicNow: () => mono,
    })!;

    builder.markQueueEnqueued(1_000);
    builder.markQueueStarted(20_000);
    builder.markHandlerStarted();
    mono = 100;
    builder.markHandlerFinished();
    builder.setResolvedTabId(-1);

    expect(builder.build()).toEqual({
      schemaVersion: 1,
      traceId: TRACE.traceId,
      transportSpanId: TRACE.transportSpanId,
      extensionRequestId: "direct_request_123",
      queueWaitMs: 5_100,
    });
  });

  it("maps only exact stable failure codes and never emits free-form error text", () => {
    const canary = "RAW_EXTENSION_ERROR_CANARY";
    const error = new Error(canary);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(telemetryErrorCategory(new Error("REQUEST_EXPIRED"))).toBe("request_expired");
    expect(telemetryErrorCategory(new Error("QUEUE_OVERLOADED"))).toBe("queue_overloaded");
    expect(telemetryErrorCategory(new Error("TAB_CLOSED"))).toBe("tab_not_found");
    expect(telemetryErrorCategory(new Error("SESSION_CLOSED"))).toBe("session_closed");
    expect(telemetryErrorCategory(new Error("EXTENSION_WORKER_RESTARTED"))).toBe("worker_restarted");
    expect(telemetryErrorCategory(error)).toBe("extension_tool_failed");

    const builder = createExtensionTelemetrySummaryBuilder({
      trace: TRACE,
      extensionRequestId: "request_1234567890",
      timeoutMs: 1_000,
      backgroundReceivedAtEpochMs: 1_000,
      monotonicNow: () => 0,
    })!;
    const evidence = JSON.stringify({
      telemetry: builder.build(telemetryErrorCategory(error)),
      console: [...warn.mock.calls, ...log.mock.calls],
    });
    warn.mockRestore();
    log.mockRestore();

    expect(evidence).not.toContain(canary);
  });

  it("stamps offscreen receipt without retaining or transforming frame content", () => {
    const frame = createOffscreenToolFrame("RAW_FRAME_CANARY", () => 1_234);
    expect(frame).toEqual({ raw: "RAW_FRAME_CANARY", receivedAtEpochMs: 1_234 });
    expect(readOffscreenToolFrame(frame)).toEqual(frame);
    expect(readOffscreenToolFrame("legacy-frame")).toEqual({ raw: "legacy-frame" });
    expect(readOffscreenToolFrame({ raw: "frame", receivedAtEpochMs: Number.NaN }))
      .toEqual({ raw: "frame" });
  });

  it("does not accept arguments, results, page data, or error text as builder inputs", () => {
    const builder = createExtensionTelemetrySummaryBuilder({
      trace: TRACE,
      extensionRequestId: "request_1234567890",
      timeoutMs: 1_000,
      backgroundReceivedAtEpochMs: 1_000,
      monotonicNow: () => 0,
    })!;
    const sensitive = {
      typedText: "RAW_TYPED_CANARY",
      formValue: "RAW_FORM_CANARY",
      clipboard: "RAW_CLIPBOARD_CANARY",
      storage: "RAW_STORAGE_CANARY",
      eval: "RAW_EVAL_CANARY",
      pageResult: "RAW_PAGE_RESULT_CANARY",
      error: "RAW_ERROR_CANARY",
    };

    const telemetry = builder.build();
    for (const canary of Object.values(sensitive)) {
      expect(JSON.stringify(telemetry)).not.toContain(canary);
    }
    expect(Object.keys(telemetry).sort()).toEqual([
      "extensionRequestId",
      "schemaVersion",
      "traceId",
      "transportSpanId",
    ]);
  });
});
