import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalStateManager } from "./state-manager.js";

const LEASE_MS = 1_800_000;

describe("LocalStateManager recording reservations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reserves a normalized name for one owner and reports conflicts", async () => {
    const state = new LocalStateManager();

    await expect(state.reserveRecording("session-a", "Checkout Flow", LEASE_MS)).resolves.toEqual({
      ok: true,
      reservation: {
        name: "Checkout_Flow",
        sessionId: "session-a",
        expiresAt: Date.now() + LEASE_MS,
      },
    });
    await expect(state.hasRecordingReservation("session-a", "Checkout Flow")).resolves.toBe(true);
    await expect(state.reserveRecording("session-b", "Checkout_Flow", LEASE_MS)).resolves.toEqual({
      ok: false,
      owner: "session-a",
    });
  });

  it("renews only the owner's live reservation", async () => {
    const state = new LocalStateManager();
    await state.reserveRecording("session-a", "demo", LEASE_MS);

    await expect(state.renewRecordingReservation("session-b", "demo", LEASE_MS)).resolves.toBe(false);
    await expect(state.renewRecordingReservation("session-a", "demo", LEASE_MS)).resolves.toBe(true);
  });

  it("rejects any lease other than exactly 30 minutes", async () => {
    const state = new LocalStateManager();

    await expect(state.reserveRecording("session-a", "demo", LEASE_MS - 1))
      .rejects.toThrow("Invalid recording reservation lease");
    await state.reserveRecording("session-a", "demo", LEASE_MS);
    await expect(state.renewRecordingReservation("session-a", "demo", LEASE_MS + 1))
      .rejects.toThrow("Invalid recording reservation lease");
  });

  it("expires after exactly 30 minutes and broadcasts once after removing state", async () => {
    const state = new LocalStateManager();
    const broadcast = vi.fn(async (_type: string, payload: unknown) => {
      expect(await state.hasRecordingReservation("session-a", "demo")).toBe(false);
      expect(payload).toEqual({ sessionId: "session-a", name: "demo" });
    });
    state.setBroadcastToBrowsersFn(broadcast);
    await state.reserveRecording("session-a", "demo", LEASE_MS);

    await vi.advanceTimersByTimeAsync(LEASE_MS - 1);
    await expect(state.hasRecordingReservation("session-a", "demo")).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(1);

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith("recording_reservation_expired", {
      sessionId: "session-a",
      name: "demo",
    });
    await vi.runAllTimersAsync();
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("renewal replaces the old timer and extends expiry", async () => {
    const state = new LocalStateManager();
    const broadcast = vi.fn();
    state.setBroadcastToBrowsersFn(broadcast);
    await state.reserveRecording("session-a", "demo", LEASE_MS);

    await vi.advanceTimersByTimeAsync(LEASE_MS - 1);
    await state.renewRecordingReservation("session-a", "demo", LEASE_MS);
    await vi.advanceTimersByTimeAsync(1);

    await expect(state.hasRecordingReservation("session-a", "demo")).resolves.toBe(true);
    expect(broadcast).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LEASE_MS - 1);
    await expect(state.hasRecordingReservation("session-a", "demo")).resolves.toBe(false);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("has expires a stale reservation when its timer callback is delayed", async () => {
    const state = new LocalStateManager();
    const broadcast = vi.fn();
    state.setBroadcastToBrowsersFn(broadcast);
    await state.reserveRecording("session-a", "demo", LEASE_MS);
    vi.setSystemTime(Date.now() + LEASE_MS);
    expect(broadcast).not.toHaveBeenCalled();

    await expect(state.hasRecordingReservation("session-a", "demo")).resolves.toBe(false);

    expect(broadcast).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("release expires a stale reservation instead of releasing it", async () => {
    const state = new LocalStateManager();
    const broadcast = vi.fn();
    state.setBroadcastToBrowsersFn(broadcast);
    await state.reserveRecording("session-a", "demo", LEASE_MS);
    vi.setSystemTime(Date.now() + LEASE_MS);

    await expect(state.releaseRecordingReservation("session-a", "demo")).resolves.toBe(false);

    expect(broadcast).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("renew expires a stale reservation instead of extending it", async () => {
    const state = new LocalStateManager();
    const broadcast = vi.fn();
    state.setBroadcastToBrowsersFn(broadcast);
    await state.reserveRecording("session-a", "demo", LEASE_MS);
    vi.setSystemTime(Date.now() + LEASE_MS);

    await expect(state.renewRecordingReservation("session-a", "demo", LEASE_MS))
      .resolves.toBe(false);

    expect(broadcast).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("reserve expires a stale owner before granting the same name", async () => {
    const state = new LocalStateManager();
    const broadcast = vi.fn();
    state.setBroadcastToBrowsersFn(broadcast);
    await state.reserveRecording("session-a", "demo", LEASE_MS);
    vi.setSystemTime(Date.now() + LEASE_MS);

    await expect(state.reserveRecording("session-b", "demo", LEASE_MS)).resolves.toMatchObject({
      ok: true,
      reservation: { name: "demo", sessionId: "session-b" },
    });

    expect(broadcast).toHaveBeenCalledTimes(1);
    await state.releaseRecordingReservation("session-b", "demo");
    await vi.runAllTimersAsync();
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("removeSession releases every owned reservation and clears its timers", async () => {
    const state = new LocalStateManager();
    const broadcast = vi.fn();
    state.setBroadcastToBrowsersFn(broadcast);
    await state.registerSession("session-a");
    await state.reserveRecording("session-a", "first", LEASE_MS);
    await state.reserveRecording("session-a", "second", LEASE_MS);
    await state.reserveRecording("session-b", "other", LEASE_MS);

    await state.removeSession("session-a");

    expect(broadcast).toHaveBeenCalledWith("session_closed", { sessionId: "session-a" });
    await expect(state.hasRecordingReservation("session-a", "first")).resolves.toBe(false);
    await expect(state.hasRecordingReservation("session-a", "second")).resolves.toBe(false);
    await expect(state.hasRecordingReservation("session-b", "other")).resolves.toBe(true);
    await vi.runAllTimersAsync();
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenCalledWith("recording_reservation_expired", {
      sessionId: "session-b",
      name: "other",
    });
  });
});
