import { isToolRequestV2, isToolResponseV2 } from "./protocol";

export class PendingToolRequests {
  private readonly requestIds = new Set<string>();

  trackInbound(raw: string): void {
    try {
      const message: unknown = JSON.parse(raw);
      if (isToolRequestV2(message)) {
        this.requestIds.add(message.id);
      }
    } catch {
      // Non-JSON WebSocket messages are not tool requests.
    }
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
      send(JSON.stringify({
        type: "messageResponse",
        payload: { requestId, error: "EXTENSION_WORKER_RESTARTED" },
      }));
    }
  }
}
