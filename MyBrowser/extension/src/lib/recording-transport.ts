import type { RecordingTransport } from './recorder';

type RecordingRequestType = 'renewRecordingReservation' | 'persistRecording';

interface PendingRequest {
  expectedType: `${RecordingRequestType}Result`;
  resolve: (value: { ok: boolean }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function randomRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `recording_request_${globalThis.crypto.randomUUID()}`;
  }
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('RECORDING_RANDOM_UNAVAILABLE');
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `recording_request_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class RecordingPortGeneration {
  private current = 0;

  constructor(private readonly disconnectCurrent: () => void) {}

  replace(): number {
    this.current += 1;
    return this.current;
  }

  disconnect(generation: number): boolean {
    if (generation !== this.current) return false;
    this.disconnectCurrent();
    return true;
  }
}

export class RecordingRequestBroker implements RecordingTransport {
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly send: (message: Record<string, unknown>) => boolean) {}

  request(type: string, payload: unknown, timeoutMs: number): Promise<{ ok: boolean }> {
    if (type !== 'renewRecordingReservation' && type !== 'persistRecording') {
      return Promise.reject(new Error('INVALID_RECORDING_REQUEST'));
    }
    const requestType = type as RecordingRequestType;
    let id: string;
    try {
      id = randomRequestId();
    } catch {
      return Promise.reject(new Error('RECORDING_RANDOM_UNAVAILABLE'));
    }
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
