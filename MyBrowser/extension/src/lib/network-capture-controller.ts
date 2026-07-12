export interface NetworkCaptureStartToken {
  readonly tabId: number;
  readonly generation: number;
}

export class NetworkCaptureController {
  private captureTargetTabId: number | null = null;
  private readonly generationByTab = new Map<number, number>();

  get active(): boolean {
    return this.captureTargetTabId !== null;
  }

  get targetTabId(): number | null {
    return this.captureTargetTabId;
  }

  isTarget(tabId: number): boolean {
    return this.captureTargetTabId === tabId;
  }

  beginStart(tabId: number): NetworkCaptureStartToken {
    return { tabId, generation: this.generationByTab.get(tabId) ?? 0 };
  }

  commitStart(token: NetworkCaptureStartToken): void {
    if ((this.generationByTab.get(token.tabId) ?? 0) !== token.generation) {
      throw new Error('TAB_CLOSED');
    }
    this.captureTargetTabId = token.tabId;
  }

  assertCanStop(tabId: number): void {
    if (this.captureTargetTabId !== null && this.captureTargetTabId !== tabId) {
      throw new Error('NETWORK_CAPTURE_TAB_MISMATCH');
    }
  }

  stop(tabId: number): void {
    this.assertCanStop(tabId);
    this.captureTargetTabId = null;
  }

  clearTab(tabId: number): void {
    this.generationByTab.set(tabId, (this.generationByTab.get(tabId) ?? 0) + 1);
    if (this.captureTargetTabId === tabId) {
      this.captureTargetTabId = null;
    }
  }
}

export async function activateNetworkCapture(
  controller: NetworkCaptureController,
  tabId: number,
  enable: () => Promise<void>,
): Promise<void> {
  const token = controller.beginStart(tabId);
  await enable();
  controller.commitStart(token);
}
