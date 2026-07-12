export class SessionConnectionRegistry<TSocket extends object> {
  private readonly socketToSession = new Map<TSocket, string>();
  private readonly sessionToSocket = new Map<string, TSocket>();

  bind(socket: TSocket, sessionId: string) {
    const existingSession = this.socketToSession.get(socket);
    const existingSocket = this.sessionToSocket.get(sessionId);
    if (
      (existingSession && existingSession !== sessionId) ||
      (existingSocket && existingSocket !== socket)
    ) {
      return { ok: false as const, code: "SESSION_IDENTITY_MISMATCH" as const };
    }
    this.socketToSession.set(socket, sessionId);
    this.sessionToSocket.set(sessionId, socket);
    return { ok: true as const };
  }

  getSession(socket: TSocket) {
    return this.socketToSession.get(socket);
  }

  hasLiveSession(sessionId: string) {
    return this.sessionToSocket.has(sessionId);
  }

  unbind(socket: TSocket) {
    const sessionId = this.socketToSession.get(socket);
    if (!sessionId) return undefined;
    this.socketToSession.delete(socket);
    if (this.sessionToSocket.get(sessionId) === socket) {
      this.sessionToSocket.delete(sessionId);
    }
    return sessionId;
  }
}
