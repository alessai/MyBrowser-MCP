import type { RecordingTransport } from './recorder';

type RecordingRequestType = 'renewRecordingReservation' | 'persistRecording';

interface PendingRequest {
  expectedType: `${RecordingRequestType}Result`;
  resolve: (value: { ok: boolean }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RecordingRequestBroker implements RecordingTransport {
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 1;

  constructor(private readonly send: (message: Record<string, unknown>) => boolean) {}

  request(type: string, payload: unknown, timeoutMs: number): Promise<{ ok: boolean }> {
    if (type !== 'renewRecordingReservation' && type !== 'persistRecording') {
      return Promise.reject(new Error('INVALID_RECORDING_REQUEST'));
    }
    const requestType = type as RecordingRequestType;
    const id = `recording_request_${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('RECORDING_TRANSPORT_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, {
        expectedType: `${requestType}Result`,
        resolve,
        reject,
        timer,
      });

      let sent = false;
      try {
        sent = this.send({
          ...(typeof payload === 'object' && payload !== null ? payload : {}),
          type: requestType,
          id,
        });
      } catch {
        sent = false;
      }
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('RECORDING_TRANSPORT_DISCONNECTED'));
      }
    });
  }

  accept(message: unknown): boolean {
    if (typeof message !== 'object' || message === null) return false;
    const candidate = message as Record<string, unknown>;
    if (typeof candidate.id !== 'string' || typeof candidate.type !== 'string') return false;
    const pending = this.pending.get(candidate.id);
    if (!pending || candidate.type !== pending.expectedType) return false;
    clearTimeout(pending.timer);
    this.pending.delete(candidate.id);
    pending.resolve({ ok: candidate.ok === true });
    return true;
  }

  disconnect(): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('RECORDING_TRANSPORT_DISCONNECTED'));
    }
    this.pending.clear();
  }
}
