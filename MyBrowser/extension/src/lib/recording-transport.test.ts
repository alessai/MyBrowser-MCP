import { afterEach, describe, expect, it, vi } from "vitest";

import { RecordingPortGeneration, RecordingRequestBroker } from "./recording-transport";
import { getRecordingTermination } from "./recording-runtime";

const SECRET = "SECRET_TRANSPORT_ALPHA_8107";

afterEach(() => {
  vi.useRealTimers();
});

describe("RecordingRequestBroker", () => {
  it("correlates only the expected result type and id", async () => {
    const sent: unknown[] = [];
    const broker = new RecordingRequestBroker((message) => {
      sent.push(message);
      return true;
    });
    const pending = broker.request("renewRecordingReservation", {
      sessionId: "session-a",
      name: "flow",
    }, 10_000);
    const id = (sent[0] as { id: string }).id;

    expect(broker.accept({ type: "persistRecordingResult", id, ok: true })).toBe(false);
    expect(broker.accept({ type: "renewRecordingReservationResult", id: "unrelated", ok: true })).toBe(false);
    expect(broker.accept({ type: "renewRecordingReservationResult", id, ok: true })).toBe(true);

    await expect(pending).resolves.toEqual({ ok: true });
    expect(sent).toEqual([{
      type: "renewRecordingReservation",
      id,
      sessionId: "session-a",
      name: "flow",
    }]);
  });

  it("rejects on timeout without replaying the request", async () => {
    vi.useFakeTimers();
    const sent: unknown[] = [];
    const broker = new RecordingRequestBroker((message) => {
      sent.push(message);
      return true;
    });
    const pending = broker.request("persistRecording", {
      sessionId: "session-a",
      payload: { name: "flow" },
    }, 10_000);
    const expectation = expect(pending).rejects.toThrow("RECORDING_TRANSPORT_TIMEOUT");

    await vi.advanceTimersByTimeAsync(10_000);

    await expectation;
    expect(sent).toHaveLength(1);
  });

  it("rejects every pending request on offscreen disconnect", async () => {
    const sent: unknown[] = [];
    const broker = new RecordingRequestBroker((message) => {
      sent.push(message);
      return true;
    });
    const renewal = broker.request("renewRecordingReservation", {
      sessionId: "session-a",
      name: "flow",
    }, 10_000);
    const persistence = broker.request("persistRecording", {
      sessionId: "session-b",
      payload: { name: "other" },
    }, 10_000);

    broker.disconnect();

    await expect(renewal).rejects.toThrow("RECORDING_TRANSPORT_DISCONNECTED");
    await expect(persistence).rejects.toThrow("RECORDING_TRANSPORT_DISCONNECTED");
  });

  it("reduces rejected server responses to a secret-free result", async () => {
    const sent: unknown[] = [];
    const broker = new RecordingRequestBroker((message) => {
      sent.push(message);
      return true;
    });
    const pending = broker.request("persistRecording", {
      sessionId: "session-a",
      payload: { name: "flow" },
    }, 10_000);
    const id = (sent[0] as { id: string }).id;

    broker.accept({ type: "persistRecordingResult", id, ok: false, error: SECRET });

    const result = await pending;
    expect(result).toEqual({ ok: false });
    expect(JSON.stringify({ sent, result })).not.toContain(SECRET);
  });

  it("rejects malformed matched acknowledgements as ambiguous", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const broker = new RecordingRequestBroker((message) => {
      sent.push(message);
      return true;
    });
    const pending = broker.request("renewRecordingReservation", {
      sessionId: "session-a",
      name: "flow",
    }, 10_000);
    const id = sent[0]!.id as string;

    expect(broker.accept({
      type: "renewRecordingReservationResult",
      id,
      ok: `INVALID_${SECRET}`,
    })).toBe(true);

    await expect(pending).rejects.toThrow("INVALID_RECORDING_RESPONSE");
    expect(JSON.stringify(sent)).not.toContain(SECRET);
  });

  it("rejects immediately when the request cannot be sent", async () => {
    const broker = new RecordingRequestBroker(() => false);

    await expect(broker.request("persistRecording", {
      sessionId: "session-a",
      payload: { name: "flow" },
    }, 10_000)).rejects.toThrow("RECORDING_TRANSPORT_DISCONNECTED");
  });

  it("cannot reuse a pre-restart id or accept its delayed response", async () => {
    const oldSent: Array<Record<string, unknown>> = [];
    const oldBroker = new RecordingRequestBroker((message) => {
      oldSent.push(message);
      return true;
    });
    const oldRequest = oldBroker.request("renewRecordingReservation", {
      sessionId: "session-a",
      name: "flow",
    }, 10_000);
    const oldId = oldSent[0]!.id as string;
    oldBroker.disconnect();
    await expect(oldRequest).rejects.toThrow("RECORDING_TRANSPORT_DISCONNECTED");

    const newSent: Array<Record<string, unknown>> = [];
    const restartedBroker = new RecordingRequestBroker((message) => {
      newSent.push(message);
      return true;
    });
    const newRequest = restartedBroker.request("renewRecordingReservation", {
      sessionId: "session-a",
      name: "flow",
    }, 10_000);
    const newId = newSent[0]!.id as string;

    expect(oldId).not.toBe(newId);
    expect(oldId).toMatch(/^recording_request_[0-9a-f-]{36}$/);
    expect(newId).toMatch(/^recording_request_[0-9a-f-]{36}$/);
    expect(restartedBroker.accept({
      type: "renewRecordingReservationResult",
      id: oldId,
      ok: true,
    })).toBe(false);
    expect(restartedBroker.accept({
      type: "renewRecordingReservationResult",
      id: newId,
      ok: true,
    })).toBe(true);
    await expect(newRequest).resolves.toEqual({ ok: true });
  });

  it("ignores a stale superseded port disconnect and rejects the current generation", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const broker = new RecordingRequestBroker((message) => {
      sent.push(message);
      return true;
    });
    const ports = new RecordingPortGeneration(() => broker.disconnect());
    const oldPort = ports.replace();
    const request = broker.request("persistRecording", {
      sessionId: "session-a",
      payload: { name: "flow" },
    }, 10_000);
    const id = sent[0]!.id as string;
    const replacement = ports.replace();

    expect(ports.disconnect(oldPort)).toBe(false);
    expect(broker.accept({ type: "persistRecordingResult", id, ok: true })).toBe(true);
    await expect(request).resolves.toEqual({ ok: true });

    const currentRequest = broker.request("persistRecording", {
      sessionId: "session-a",
      payload: { name: "next" },
    }, 10_000);
    expect(ports.disconnect(replacement)).toBe(true);
    await expect(currentRequest).rejects.toThrow("RECORDING_TRANSPORT_DISCONNECTED");
  });
});

describe("recording lifecycle broadcasts", () => {
  it("extracts nested session closure and reservation expiry identities", () => {
    expect(getRecordingTermination({
      id: "bcast-1",
      type: "session_closed",
      payload: { sessionId: "session-a" },
    })).toEqual({ sessionId: "session-a", reason: "session_closed" });
    expect(getRecordingTermination({
      id: "bcast-2",
      type: "recording_reservation_expired",
      payload: { sessionId: "session-b", name: "flow" },
    })).toEqual({ sessionId: "session-b", name: "flow", reason: "reservation_expired" });
    for (const sessionId of ["", "has space", "has:colon", "x".repeat(129)]) {
      expect(getRecordingTermination({
        type: "session_closed",
        payload: { sessionId },
      })).toBeUndefined();
    }
    expect(getRecordingTermination({
      type: "recording_reservation_expired",
      payload: { sessionId: "session-b" },
    })).toBeUndefined();
    expect(getRecordingTermination({
      type: "session_closed",
      sessionId: "untrusted-top-level",
    })).toBeUndefined();
  });
});
