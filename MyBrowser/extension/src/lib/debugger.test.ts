import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { enableRuntime, isConsoleCaptureActive, sendCommand } from "./debugger";

describe("sendCommand", () => {
  let attach: ReturnType<typeof vi.fn>;
  let command: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    attach = vi.fn(async () => undefined);
    command = vi.fn();
    vi.stubGlobal("chrome", {
      debugger: {
        attach,
        detach: vi.fn(async () => undefined),
        sendCommand: command,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries once after recovering from debugger detachment", async () => {
    command
      .mockRejectedValueOnce(new Error("Detached while handling command."))
      .mockResolvedValueOnce({ enabled: true });

    await expect(sendCommand(4, "Network.enable")).resolves.toEqual({ enabled: true });
    expect(attach).toHaveBeenCalledWith({ tabId: 4 }, "1.3");
    expect(command).toHaveBeenCalledTimes(2);
  });

  it("propagates a failed retry after debugger recovery", async () => {
    command
      .mockRejectedValueOnce(new Error("Detached while handling command."))
      .mockRejectedValueOnce(new Error("Network.enable failed"));

    await expect(sendCommand(4, "Network.enable")).rejects.toThrow("Network.enable failed");
    expect(command).toHaveBeenCalledTimes(2);
  });

  it("reports console capture only after Runtime.enable succeeds", async () => {
    command.mockResolvedValue(undefined);

    expect(isConsoleCaptureActive(44)).toBe(false);
    await enableRuntime(44);
    expect(isConsoleCaptureActive(44)).toBe(true);
  });
});
