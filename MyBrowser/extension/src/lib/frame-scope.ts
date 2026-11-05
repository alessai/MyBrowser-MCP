// Which embedded frame a tool call on a tab is running in (see withFrame in
// tools.ts). Kept free of imports: the content script bundles messaging.ts,
// which reads this. Tool calls on one tab are queued, so one scope per tab is enough.

export interface FrameScope {
  frameId: number;
  url: string;
  /** Top-left of the frame in top-page viewport pixels, when known. */
  offset?: { x: number; y: number };
}

const scopes = new Map<number, FrameScope>();

export function frameScope(tabId: number): FrameScope | undefined {
  return scopes.get(tabId);
}

export function setFrameScope(tabId: number, scope: FrameScope | undefined): void {
  if (scope) scopes.set(tabId, scope);
  else scopes.delete(tabId);
}
