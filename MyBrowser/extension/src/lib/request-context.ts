import { InputDevice } from './input-device';

export interface RequestSessionState {
  setLastTab(sessionId: string, tabId: number): Promise<void>;
  clearTab(tabId: number): Promise<void>;
}

export interface RequestToolContextOptions {
  sessionId: string;
  requestId: string;
  expiresAt: number;
  tabId: number;
  sessionState: RequestSessionState;
}

export class RequestToolContext {
  readonly sessionId: string;
  readonly requestId: string;
  readonly expiresAt: number;
  readonly input: InputDevice;
  private tabId: number;

  constructor(private readonly options: RequestToolContextOptions) {
    this.sessionId = options.sessionId;
    this.requestId = options.requestId;
    this.expiresAt = options.expiresAt;
    this.tabId = options.tabId;
    this.input = new InputDevice(options.tabId);
  }

  getTabId(): number {
    return this.tabId;
  }

  async setTabId(tabId: number): Promise<void> {
    this.tabId = tabId;
    this.input.updateTabId(tabId);
    await this.options.sessionState.setLastTab(this.sessionId, tabId);
  }

  async clearTab(tabId: number): Promise<void> {
    if (this.tabId === tabId) {
      this.tabId = -1;
      this.input.updateTabId(-1);
    }
    await this.options.sessionState.clearTab(tabId);
  }
}
