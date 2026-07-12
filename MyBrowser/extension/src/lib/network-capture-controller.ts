export class NetworkCaptureController {
  private captureTargetTabId: number | null = null;

  get active(): boolean {
    return this.captureTargetTabId !== null;
  }

  get targetTabId(): number | null {
    return this.captureTargetTabId;
  }

  isTarget(tabId: number): boolean {
    return this.captureTargetTabId === tabId;
  }

  start(tabId: number): void {
    this.captureTargetTabId = tabId;
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
    if (this.captureTargetTabId === tabId) {
      this.captureTargetTabId = null;
    }
  }
}
