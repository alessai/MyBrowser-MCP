import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dispatchScheduledRequest,
  RequestScheduler,
  type RequestMeta,
} from "./request-scheduler";
import { TOOL_METADATA, type ToolName } from "./tool-metadata";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function meta(overrides: Partial<RequestMeta> = {}): RequestMeta {
  return {
    requestId: "request-a",
    sessionId: "session-a",
    expiresAt: 10_000,
    ...overrides,
  };
}

describe("RequestScheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("aborts expired running work and advances the queue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const scheduler = new RequestScheduler();
    const hung = deferred<void>();
    let runningSignal: AbortSignal | undefined;
    let nextStarted = false;

    const running = scheduler.runTab(1, meta({ expiresAt: 1_000 }), async (signal) => {
      runningSignal = signal;
      return hung.promise;
    });
    const next = scheduler.runTab(1, meta({ requestId: "next", expiresAt: 10_000 }), async () => {
      nextStarted = true;
    });
    const rejection = expect(running).rejects.toThrow("REQUEST_EXPIRED");

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    await expect(next).resolves.toBeUndefined();
    expect(runningSignal?.aborted).toBe(true);
    expect(nextStarted).toBe(true);
    hung.resolve();
  });

  it("invokes the optional start callback exactly once for every queue kind", async () => {
    let now = 10;
    const scheduler = new RequestScheduler({ now: () => now++ });
    const started: Array<[string, number]> = [];

    for (const queue of ["tab", "session", "global", "none"] as const) {
      await dispatchScheduledRequest(
        scheduler,
        queue,
        1,
        meta({
          requestId: queue,
          onStart: (startedAt) => started.push([queue, startedAt]),
        }),
        async () => queue,
      );
    }

    expect(started).toEqual([
      ["tab", 10],
      ["session", 11],
      ["global", 12],
      ["none", 13],
    ]);
  });

  it("calls onStart only when queued work actually starts and ignores callback failures", async () => {
    const scheduler = new RequestScheduler({ now: () => 5 });
    const running = deferred<void>();
    const active = scheduler.runTab(1, meta(), () => running.promise);
    let queuedStarts = 0;
    const queued = scheduler.runTab(1, meta({
      requestId: "queued",
      onStart: () => {
        queuedStarts += 1;
        throw new Error("telemetry callback must be inert");
      },
    }), async () => "done");

    expect(queuedStarts).toBe(0);
    running.resolve();
    await active;
    await expect(queued).resolves.toBe("done");
    expect(queuedStarts).toBe(1);
  });

  it("starts work for two tabs concurrently", async () => {
    const scheduler = new RequestScheduler({ now: () => 0 });
    const first = deferred<string>();
    const second = deferred<string>();
    const started: number[] = [];

    const a = scheduler.runTab(1, meta(), async () => {
      started.push(1);
      return first.promise;
    });
    const b = scheduler.runTab(2, meta({ requestId: "request-b" }), async () => {
      started.push(2);
      return second.promise;
    });

    expect(started).toEqual([1, 2]);
    first.resolve("a");
    second.resolve("b");
    await expect(Promise.all([a, b])).resolves.toEqual(["a", "b"]);
  });

  it("runs same-tab work in FIFO order", async () => {
    const scheduler = new RequestScheduler({ now: () => 0 });
    const first = deferred<void>();
    const started: string[] = [];

    const a = scheduler.runTab(1, meta(), async () => {
      started.push("a");
      return first.promise;
    });
    const b = scheduler.runTab(1, meta({ requestId: "request-b" }), async () => {
      started.push("b");
    });

    expect(started).toEqual(["a"]);
    first.resolve();
    await Promise.all([a, b]);
    expect(started).toEqual(["a", "b"]);
  });

  it("continues a tab queue after running work rejects", async () => {
    const scheduler = new RequestScheduler({ now: () => 0 });
    const first = deferred<void>();
    let secondStarted = false;

    const a = scheduler.runTab(1, meta(), () => first.promise);
    const b = scheduler.runTab(1, meta({ requestId: "request-b" }), async () => {
      secondStarted = true;
    });
    first.reject(new Error("failed"));

    await expect(a).rejects.toThrow("failed");
    await expect(b).resolves.toBeUndefined();
    expect(secondStarted).toBe(true);
  });

  it("rejects the 101st pending request for one tab", async () => {
    const scheduler = new RequestScheduler({ now: () => 0 });
    const running = deferred<void>();
    const active = scheduler.runTab(1, meta(), () => running.promise);
    const queued = Array.from({ length: 100 }, (_, index) =>
      scheduler.runTab(1, meta({ requestId: `queued-${index}` }), async () => undefined),
    );

    await expect(
      scheduler.runTab(1, meta({ requestId: "over-limit" }), async () => undefined),
    ).rejects.toThrow("QUEUE_OVERLOADED");

    scheduler.cancelTab(1, "TAB_CLOSED");
    running.resolve();
    await active;
    const results = await Promise.allSettled(queued);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
  });

  it("enforces the global pending limit across queue types", async () => {
    const scheduler = new RequestScheduler({ now: () => 0, maxPendingGlobal: 2 });
    const tabRunning = deferred<void>();
    const sessionRunning = deferred<void>();
    const globalRunning = deferred<void>();
    const tabActive = scheduler.runTab(1, meta(), () => tabRunning.promise);
    const sessionActive = scheduler.runSession("session-b", meta({ sessionId: "session-b" }), () => sessionRunning.promise);
    const globalActive = scheduler.runGlobal(meta({ sessionId: "session-c" }), () => globalRunning.promise);
    const tabQueued = scheduler.runTab(1, meta({ requestId: "tab-pending" }), async () => undefined);
    const sessionQueued = scheduler.runSession("session-b", meta({ requestId: "session-pending", sessionId: "session-b" }), async () => undefined);

    await expect(
      scheduler.runGlobal(meta({ requestId: "global-over-limit" }), async () => undefined),
    ).rejects.toThrow("QUEUE_OVERLOADED");

    scheduler.cancelTab(1, "TAB_CLOSED");
    scheduler.cancelSession("session-b", "SESSION_NOT_REGISTERED");
    tabRunning.resolve();
    sessionRunning.resolve();
    globalRunning.resolve();
    await Promise.all([tabActive, sessionActive, globalActive]);
    await Promise.allSettled([tabQueued, sessionQueued]);
  });

  it("rejects request 501 across mixed queue types by default", async () => {
    const scheduler = new RequestScheduler({ now: () => 0 });
    const tabRunning = deferred<void>();
    const sessionRunning = deferred<void>();
    const globalRunning = deferred<void>();
    const active = [
      scheduler.runTab(1, meta({ sessionId: "tab-session" }), () => tabRunning.promise),
      scheduler.runSession("session-b", meta({ sessionId: "session-b" }), () => sessionRunning.promise),
      scheduler.runGlobal(meta({ sessionId: "global-session" }), () => globalRunning.promise),
    ];
    const queued = [
      ...Array.from({ length: 100 }, (_, index) =>
        scheduler.runTab(1, meta({ requestId: `tab-${index}`, sessionId: "tab-session" }), async () => undefined),
      ),
      ...Array.from({ length: 200 }, (_, index) =>
        scheduler.runSession("session-b", meta({ requestId: `session-${index}`, sessionId: "session-b" }), async () => undefined),
      ),
      ...Array.from({ length: 200 }, (_, index) =>
        scheduler.runGlobal(meta({ requestId: `global-${index}`, sessionId: "global-session" }), async () => undefined),
      ),
    ];
    const settled = Promise.allSettled(queued);

    const overloaded = scheduler.runGlobal(
      meta({ requestId: "global-over-limit", sessionId: "over-limit" }),
      async () => undefined,
    );

    expect(scheduler.pendingCount).toBe(500);
    await expect(overloaded).rejects.toThrow("QUEUE_OVERLOADED");

    scheduler.cancelTab(1, "TAB_CLOSED");
    scheduler.cancelSession("session-b", "SESSION_NOT_REGISTERED");
    scheduler.cancelSession("global-session", "SESSION_NOT_REGISTERED");
    tabRunning.resolve();
    sessionRunning.resolve();
    globalRunning.resolve();
    await Promise.all(active);
    const results = await settled;
    expect(results.every((result) => result.status === "rejected")).toBe(true);
  });

  it("cancelTab rejects queued work without cancelling running work", async () => {
    const scheduler = new RequestScheduler({ now: () => 0 });
    const running = deferred<string>();
    const active = scheduler.runTab(4, meta(), () => running.promise);
    const queued = scheduler.runTab(4, meta({ requestId: "queued" }), async () => "queued");

    scheduler.cancelTab(4, "TAB_CLOSED");
    running.resolve("running");

    await expect(active).resolves.toBe("running");
    await expect(queued).rejects.toThrow("TAB_CLOSED");
  });

  it("cancelSession rejects matching queued work in every queue", async () => {
    const scheduler = new RequestScheduler({ now: () => 0 });
    const tabRunning = deferred<void>();
    const globalRunning = deferred<void>();
    const tabActive = scheduler.runTab(1, meta({ sessionId: "other" }), () => tabRunning.promise);
    const globalActive = scheduler.runGlobal(meta({ sessionId: "other" }), () => globalRunning.promise);
    const tabQueued = scheduler.runTab(1, meta({ sessionId: "target", requestId: "tab-target" }), async () => undefined);
    const globalQueued = scheduler.runGlobal(meta({ sessionId: "target", requestId: "global-target" }), async () => undefined);

    scheduler.cancelSession("target", "SESSION_NOT_REGISTERED");
    tabRunning.resolve();
    globalRunning.resolve();

    await Promise.all([tabActive, globalActive]);
    await expect(tabQueued).rejects.toThrow("SESSION_NOT_REGISTERED");
    await expect(globalQueued).rejects.toThrow("SESSION_NOT_REGISTERED");
  });

  it("closes a session without interrupting running work or starting later work", async () => {
    const scheduler = new RequestScheduler({ now: () => 0 });
    const running = deferred<string>();
    const active = scheduler.runSession("target", meta({ sessionId: "target" }), () => (
      running.promise
    ));
    let queuedStarted = false;
    const queued = scheduler.runSession(
      "target",
      meta({ sessionId: "target", requestId: "queued" }),
      async () => {
        queuedStarted = true;
      },
    );

    scheduler.cancelSession("target", "SESSION_CLOSED");

    await expect(queued).rejects.toThrow("SESSION_CLOSED");
    expect(queuedStarted).toBe(false);
    let laterStarted = false;
    const later = scheduler.runTab(
      2,
      meta({ sessionId: "target", requestId: "later" }),
      async () => {
        laterStarted = true;
      },
    );
    await expect(later).rejects.toThrow("SESSION_CLOSED");
    expect(laterStarted).toBe(false);

    running.resolve("finished");
    await expect(active).resolves.toBe("finished");
  });

  it.each([
    "browser_wait",
    "browser_download",
    "browser_list_handlers",
  ] satisfies ToolName[])("rejects closed-session queue:none %s work in the dispatcher", async (toolName) => {
    const scheduler = new RequestScheduler({ now: () => 0 });
    scheduler.cancelSession("target", "SESSION_CLOSED");
    let started = false;

    const result = dispatchScheduledRequest(
      scheduler,
      TOOL_METADATA[toolName].queue,
      -1,
      meta({ sessionId: "target", requestId: toolName }),
      async () => {
        started = true;
      },
    );

    await expect(result).rejects.toThrow("SESSION_CLOSED");
    expect(started).toBe(false);
  });

  it("allows already-running queue:none work to complete after closure", async () => {
    const scheduler = new RequestScheduler({ now: () => 0 });
    const running = deferred<string>();
    const active = dispatchScheduledRequest(
      scheduler,
      "none",
      -1,
      meta({ sessionId: "target" }),
      () => running.promise,
    );

    scheduler.cancelSession("target", "SESSION_CLOSED");
    running.resolve("finished");

    await expect(active).resolves.toBe("finished");
  });

  it("does not invoke queued work after it expires", async () => {
    let now = 0;
    const scheduler = new RequestScheduler({ now: () => now });
    const running = deferred<void>();
    const active = scheduler.runTab(1, meta(), () => running.promise);
    let invoked = false;
    const queued = scheduler.runTab(1, meta({ requestId: "expired", expiresAt: 5 }), async () => {
      invoked = true;
    });

    now = 6;
    running.resolve();
    await active;

    await expect(queued).rejects.toThrow("REQUEST_EXPIRED");
    expect(invoked).toBe(false);
  });

  it("deletes queues when they become idle", async () => {
    const scheduler = new RequestScheduler({ now: () => 0 });

    await scheduler.runTab(1, meta(), async () => undefined);
    await scheduler.runSession("session-a", meta(), async () => undefined);
    await scheduler.runGlobal(meta(), async () => undefined);

    expect(scheduler.queueCount).toBe(0);
    expect(scheduler.pendingCount).toBe(0);
  });
});
