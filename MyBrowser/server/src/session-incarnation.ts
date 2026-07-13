import { randomUUID } from "node:crypto";
import type { IStateManager } from "./state-manager.js";

export class SessionIncarnation {
  private currentSessionId: string;

  constructor(initialSessionId: string = randomUUID()) {
    this.currentSessionId = initialSessionId;
  }

  get sessionId(): string {
    return this.currentSessionId;
  }

  async register(
    stateManager: IStateManager,
    name?: string,
  ): Promise<{ rotated: boolean; sessionId: string }> {
    try {
      await stateManager.registerSession(this.currentSessionId, name);
      return { rotated: false, sessionId: this.currentSessionId };
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "SESSION_FINALIZED") throw error;
    }

    this.currentSessionId = randomUUID();
    await stateManager.registerSession(this.currentSessionId, name);
    return { rotated: true, sessionId: this.currentSessionId };
  }
}
