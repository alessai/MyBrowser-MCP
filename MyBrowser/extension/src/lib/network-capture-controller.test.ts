import { describe, expect, it } from "vitest";

import { NetworkCaptureController } from "./network-capture-controller";

describe("NetworkCaptureController", () => {
  it("owns the browser-global capture target explicitly", () => {
    const controller = new NetworkCaptureController();

    expect(controller.active).toBe(false);
    expect(controller.targetTabId).toBeNull();

    controller.start(4);
    expect(controller.active).toBe(true);
    expect(controller.targetTabId).toBe(4);
    expect(controller.isTarget(4)).toBe(true);

    controller.start(8);
    expect(controller.targetTabId).toBe(8);
    expect(controller.isTarget(4)).toBe(false);
  });

  it("rejects a stop from another tab without changing the target", () => {
    const controller = new NetworkCaptureController();
    controller.start(4);

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
});
