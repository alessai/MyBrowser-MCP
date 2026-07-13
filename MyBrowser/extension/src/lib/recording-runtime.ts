import { RecordingManager } from './recorder';
import { RecordingRequestBroker } from './recording-transport';
import { isValidV2SessionId } from './session-id';

let sendRecordingMessage: (message: Record<string, unknown>) => boolean = () => false;
const broker = new RecordingRequestBroker((message) => sendRecordingMessage(message));
let manager: RecordingManager | undefined;

export function configureRecordingTransport(
  send: (message: Record<string, unknown>) => boolean,
): void {
  sendRecordingMessage = send;
}

export function getRecordingManager(): RecordingManager {
  manager ??= new RecordingManager({ transport: broker });
  return manager;
}

export function acceptRecordingServerMessage(message: unknown): boolean {
  return broker.accept(message);
}

export function disconnectRecordingTransport(): void {
  broker.disconnect();
}

export function getRecordingTermination(message: unknown):
  | { sessionId: string; name?: string; reason: 'session_closed' | 'reservation_expired' }
  | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const candidate = message as Record<string, unknown>;
  if (candidate.type !== 'session_closed'
    && candidate.type !== 'recording_reservation_expired') return undefined;
  if (typeof candidate.payload !== 'object' || candidate.payload === null) return undefined;
  const sessionId = (candidate.payload as Record<string, unknown>).sessionId;
  if (!isValidV2SessionId(sessionId)) return undefined;
  const name = (candidate.payload as Record<string, unknown>).name;
  if (candidate.type === 'recording_reservation_expired'
    && (typeof name !== 'string' || name.length === 0)) return undefined;
  return {
    sessionId,
    ...(candidate.type === 'recording_reservation_expired' ? { name: name as string } : {}),
    reason: candidate.type === 'session_closed' ? 'session_closed' : 'reservation_expired',
  };
}
