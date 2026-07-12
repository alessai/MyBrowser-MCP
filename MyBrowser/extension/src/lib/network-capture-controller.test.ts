import { describe, expect, it } from "vitest";

import {
  activateNetworkCapture,
  NetworkCaptureController,
} from "./network-capture-controller";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function commitCapture(controller: NetworkCaptureController, tabId: number): void {
  controller.commitStart(controller.beginStart(tabId));
}

describe("NetworkCaptureController", () => {
  it("owns the browser-global capture target explicitly", () => {
    const controller = new NetworkCaptureController();

    expect(controller.active).toBe(false);
    expect(controller.targetTabId).toBeNull();

    commitCapture(controller, 4);
    expect(controller.active).toBe(true);
    expect(controller.targetTabId).toBe(4);
    expect(controller.isTarget(4)).toBe(true);

    commitCapture(controller, 8);
    expect(controller.targetTabId).toBe(8);
    expect(controller.isTarget(4)).toBe(false);
  });

  it("rejects a stop from another tab without changing the target", () => {
    const controller = new NetworkCaptureController();
    commitCapture(controller, 4);

    expect(() => controller.stop(8)).toThrow("NETWORK_CAPTURE_TAB_MISMATCH");
    expect(controller.active).toBe(true);
    expect(controller.targetTabId).toBe(4);

    controller.stop(4);
    expect(controller.active).toBe(false);
    expect(controller.targetTabId).toBeNull();
  });

  it("keeps stop idempotent when no capture is active", () => {
    const controller = new NetworkCaptureController();

    expect(() => controller.stop(4)).not.toThrow();
    expect(controller.targetTabId).toBeNull();
  });

  it("deactivates capture when its target tab closes", () => {
    const controller = new NetworkCaptureController();
    commitCapture(controller, 4);

    controller.clearTab(4);
    controller.clearTab(4);

    expect(controller.active).toBe(false);
    expect(controller.targetTabId).toBeNull();
  });

  it("keeps capture active when an unrelated tab closes", () => {
    const controller = new NetworkCaptureController();
    commitCapture(controller, 4);

    controller.clearTab(8);

    expect(controller.active).toBe(true);
    expect(controller.targetTabId).toBe(4);
  });

  it("does not let a reused tab ID inherit capture after closure", () => {
    const controller = new NetworkCaptureController();
    commitCapture(controller, 4);

    controller.clearTab(4);

    expect(controller.isTarget(4)).toBe(false);
  });

  it("rejects activation when the tab closes during attach", async () => {
    const controller = new NetworkCaptureController();
    const attach = deferred();
    let enableReached = false;
    const activation = activateNetworkCapture(controller, 4, async () => {
      await attach.promise;
      enableReached = true;
    });

    controller.clearTab(4);
    attach.resolve();

    await expect(activation).rejects.toThrow("TAB_CLOSED");
    expect(enableReached).toBe(true);
    expect(controller.active).toBe(false);
  });

  it("rejects activation when the tab closes during Network.enable", async () => {
    const controller = new NetworkCaptureController();
    const enable = deferred();
    const activation = activateNetworkCapture(controller, 4, () => enable.promise);

    controller.clearTab(4);
    enable.resolve();

    await expect(activation).rejects.toThrow("TAB_CLOSED");
    expect(controller.active).toBe(false);
  });

  it("does not commit capture when Network.enable fails", async () => {
    const controller = new NetworkCaptureController();

    await expect(activateNetworkCapture(controller, 4, async () => {
      throw new Error("Network.enable failed");
    })).rejects.toThrow("Network.enable failed");
    expect(controller.active).toBe(false);
  });

  it("allows a genuine same-ID start after closure", () => {
    const controller = new NetworkCaptureController();
    const stale = controller.beginStart(4);

    controller.clearTab(4);
    expect(() => controller.commitStart(stale)).toThrow("TAB_CLOSED");

    commitCapture(controller, 4);
    expect(controller.isTarget(4)).toBe(true);
  });
});
