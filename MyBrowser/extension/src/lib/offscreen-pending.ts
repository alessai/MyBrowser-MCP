import { isToolRequestV2, isToolResponseV2 } from "./protocol";

export class PendingToolRequests {
  private readonly requestIds = new Set<string>();

  trackInbound(raw: string): boolean {
    try {
      const message: unknown = JSON.parse(raw);
      if (isToolRequestV2(message)) {
        this.requestIds.add(message.id);
        return message.trace !== undefined;
      }
    } catch {
      // Non-JSON WebSocket messages are not tool requests.
    }
    return false;
  }

  completeOutbound(raw: string): void {
    try {
      const message: unknown = JSON.parse(raw);
      if (isToolResponseV2(message)) {
        this.requestIds.delete(message.payload.requestId);
      }
    } catch {
      // Non-JSON worker messages cannot complete tool requests.
    }
  }

  failAll(send: (raw: string) => void): void {
    const requestIds = [...this.requestIds];
    this.requestIds.clear();

    for (const requestId of requestIds) {
      try {
        send(JSON.stringify({
          type: "messageResponse",
          payload: { requestId, error: "EXTENSION_WORKER_RESTARTED" },
        }));
      } catch {
        // A failed send must not skip the remaining correlated failures.
      }
    }
  }
}
