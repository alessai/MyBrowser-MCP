import { RecordingManager } from './recorder';
import { RecordingRequestBroker } from './recording-transport';

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

export function getTerminatedRecordingSession(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const candidate = message as Record<string, unknown>;
  if (candidate.type !== 'session_closed'
    && candidate.type !== 'recording_reservation_expired') return undefined;
  if (typeof candidate.payload !== 'object' || candidate.payload === null) return undefined;
  const sessionId = (candidate.payload as Record<string, unknown>).sessionId;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
}
