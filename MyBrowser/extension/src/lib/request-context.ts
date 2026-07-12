import { InputDevice } from './input-device';
import type { NetworkCaptureController } from './network-capture-controller';

export interface InitialTabResolutionOptions {
  requirement: 'required' | 'optional' | 'none';
  requestedTabId?: unknown;
  sessionFallback?: number;
  resolveTabId(requestedTabId?: number, sessionFallback?: number): Promise<number>;
  clearFallback(): Promise<void>;
}

export async function resolveInitialTab(options: InitialTabResolutionOptions): Promise<number> {
  const {
    requirement,
    requestedTabId,
    sessionFallback,
    resolveTabId,
    clearFallback,
  } = options;

  if (requirement === 'none') return -1;
  if (requestedTabId !== undefined) {
    if (
      typeof requestedTabId !== 'number' ||
      !Number.isInteger(requestedTabId) ||
      requestedTabId <= 0
    ) {
      throw new Error('TAB_NOT_FOUND');
    }
    return resolveTabId(requestedTabId);
  }

  try {
    const tabId = await resolveTabId(undefined, sessionFallback);
    if (sessionFallback !== undefined && tabId !== sessionFallback) {
      await clearFallback();
    }
    return tabId;
  } catch (error) {
    if (sessionFallback !== undefined) await clearFallback();
    if (requirement === 'required') throw error;
    return -1;
  }
}

export interface RequestSessionState {
  setLastTab(sessionId: string, tabId: number): Promise<void>;
  clearTab(tabId: number): Promise<void>;
}

export interface RequestToolServices {
  networkCapture: NetworkCaptureController;
}

export interface RequestToolContextOptions {
  sessionId: string;
  requestId: string;
  expiresAt: number;
  tabId: number;
  sessionState: RequestSessionState;
  services: RequestToolServices;
}

export class RequestToolContext {
  readonly sessionId: string;
  readonly requestId: string;
  readonly expiresAt: number;
  readonly input: InputDevice;
  readonly services: RequestToolServices;
  private tabId: number;

  constructor(private readonly options: RequestToolContextOptions) {
    this.sessionId = options.sessionId;
    this.requestId = options.requestId;
    this.expiresAt = options.expiresAt;
    this.tabId = options.tabId;
    this.input = new InputDevice(options.tabId);
    this.services = options.services;
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
