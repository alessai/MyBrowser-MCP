// F1: browser_on — extension-side event handler registry.
//
// The hub is authoritative for handler state; this module mirrors the
// hub's registry so event dispatch can be synchronous (dialogs need an
// immediate response before the browser hangs). Handlers are pushed
// from the hub via the `browser_register_handler` tool message and
// cleared on `browser_unregister_handler`.
//
// When an event fires (dialog intercept, tab creation, network timeout),
// `dispatchEvent()` finds matching handlers and returns the action they
// want, which the caller executes synchronously. For action=emit, this
// module also calls `sendToServer("eventEmitted", ...)` directly.

export type EventName =
  | "dialog"
  | "beforeunload"
  | "new_tab"
  | "network_timeout";

export type HandlerAction = "dismiss" | "accept" | "emit" | "ignore";

export interface HandlerOptions {
  promptText?: string;
  thresholdMs?: number;
  eventName?: string;
  tabId?: number;
}

export interface EventHandler {
  id: string;
  /** Session that installed this handler (carried back to the hub
   *  with every emit so events land in the owner's queue namespace). */
  sessionId: string;
  browserId: string;
  event: EventName;
  action: HandlerAction;
  options?: HandlerOptions;
  createdAt: number;
}

/** Outcome of dispatching an event through the handler registry. */
export interface DispatchResult {
  matched: EventHandler | null;
  /** Actions the caller must execute synchronously. */
  execute: {
    /** For dialog: dismiss vs accept (with optional promptText). */
    dialog?: {
      accept: boolean;
      promptText?: string;
    };
    /** For new_tab: close it? */
    closeNewTab?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Local registry
// ---------------------------------------------------------------------------

const handlers: EventHandler[] = [];

export function addHandler(h: EventHandler): void {
  // Replace by id if already present (hub might re-push on reconnect).
  const idx = handlers.findIndex((existing) => existing.id === h.id);
  if (idx >= 0) {
    handlers[idx] = h;
  } else {
    handlers.push(h);
  }
}

export function removeHandler(id: string): boolean {
  const idx = handlers.findIndex((h) => h.id === id);
  if (idx < 0) return false;
  handlers.splice(idx, 1);
  return true;
}

export function clearHandlers(): void {
  handlers.length = 0;
}

export function listHandlers(): EventHandler[] {
  return handlers.slice();
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Find the handler that should react to an event. Matching rules:
 *   1. Tab-scoped handlers (options.tabId set) are strictly narrower
 *      than browser-wide handlers and ALWAYS win when the firing tab
 *      matches, regardless of registration order.
 *   2. Among handlers of the same specificity, most recently registered
 *      wins (so re-registration replaces effective policy).
 *
 * This avoids the "broad rule shadows narrow rule because it was
 * registered first" footgun that order-based matching introduces.
 */
export function findMatchingHandler(
  event: EventName,
  tabId?: number,
): EventHandler | null {
  let tabScopedMatch: EventHandler | null = null;
  let browserWideMatch: EventHandler | null = null;

  for (const h of handlers) {
    if (h.event !== event) continue;
    const scopedTab = h.options?.tabId;
    if (scopedTab !== undefined) {
      if (tabId !== scopedTab) continue;
      // Narrower match — prefer the most recent one (overwrite).
      tabScopedMatch = h;
    } else {
      // Browser-wide — prefer the most recent one.
      browserWideMatch = h;
    }
  }

  return tabScopedMatch ?? browserWideMatch;
}

// ---------------------------------------------------------------------------
// Emit path (action=emit pushes events to the hub)
// ---------------------------------------------------------------------------

export interface EmitPayload {
  /** Owning session — required so the hub routes the event into the
   *  correct session's queue namespace. */
  sessionId: string;
  browserId?: string;
  event: EventName;
  queueName: string;
  data: unknown;
  tabId?: number;
}

/**
 * Call this when a handler with action=emit has matched. Sends the
 * event to the hub over WS so a hub-side browser_wait_for_event can
 * consume it. Fire-and-forget from the extension's perspective.
 */
export async function emitToHub(payload: EmitPayload): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      type: "_os_ws_send",
      payload: JSON.stringify({ type: "eventEmitted", payload }),
    });
  } catch {
    /* server may be disconnected; hub-side re-sync on reconnect will
       not recover missed events by design (events are ephemeral) */
  }
}

// ---------------------------------------------------------------------------
// Dispatch helpers (return what the caller should execute)
// ---------------------------------------------------------------------------

/**
 * Dispatch a dialog event (alert / confirm / prompt / beforeunload).
 * Returns instructions for `Page.handleJavaScriptDialog`.
 *
 * Default behavior when no handler matches: LEAVE ALONE. Caller must
 * NOT call handleJavaScriptDialog in that case — the dialog stays open
 * so the user can respond manually. Auto-dismissing without explicit
 * opt-in is too magical and unsafe. Users must register a handler via
 * browser_on if they want automatic reactions.
 */
export function dispatchDialog(
  data: { type: string; message: string; url?: string; defaultPrompt?: string },
  tabId?: number,
): DispatchResult {
  // beforeunload dialogs surface through the same Page.javascriptDialogOpening
  // CDP event with type="beforeunload"; route them to the beforeunload
  // handler if one is registered, otherwise to the dialog handler.
  const eventName: EventName =
    data.type === "beforeunload" ? "beforeunload" : "dialog";
  const handler = findMatchingHandler(eventName, tabId);

  if (!handler) {
    // No handler registered — leave the dialog alone so the user can
    // respond. Returning matched: null signals "don't call
    // Page.handleJavaScriptDialog".
    return { matched: null, execute: {} };
  }

  if (handler.action === "ignore") {
    return { matched: handler, execute: {} };
  }

  if (handler.action === "emit") {
    if (handler.options?.eventName) {
      emitToHub({
        sessionId: handler.sessionId,
        event: eventName,
        queueName: handler.options.eventName,
        data,
        tabId,
      });
    }
    // emit does NOT auto-resolve the dialog — still dismiss it so the
    // page can continue. Emit semantics: "notify AND dismiss".
    return { matched: handler, execute: { dialog: { accept: false } } };
  }

  const accept = handler.action === "accept";
  return {
    matched: handler,
    execute: {
      dialog: {
        accept,
        promptText: accept ? handler.options?.promptText : undefined,
      },
    },
  };
}

/**
 * Dispatch a new_tab event. Returns whether the tab should be closed.
 */
export function dispatchNewTab(
  data: { tabId: number; openerTabId?: number; url?: string },
): DispatchResult {
  const handler = findMatchingHandler("new_tab", data.tabId);
  if (!handler) return { matched: null, execute: {} };
  if (handler.action === "ignore") return { matched: handler, execute: {} };

  if (handler.action === "emit") {
    if (handler.options?.eventName) {
      emitToHub({
        sessionId: handler.sessionId,
        event: "new_tab",
        queueName: handler.options.eventName,
        data,
        tabId: data.tabId,
      });
    }
    return { matched: handler, execute: {} };
  }

  // dismiss = close the new tab; accept = leave it open
  const closeIt = handler.action === "dismiss";
  return { matched: handler, execute: { closeNewTab: closeIt } };
}

/**
 * Dispatch a network_timeout event. No synchronous action needed — all
 * that can happen is emit. Returns matched handler so callers can
 * optionally log/track it.
 */
export function dispatchNetworkTimeout(
  data: {
    requestId: string;
    url: string;
    method: string;
    pendingMs: number;
  },
  tabId?: number,
): DispatchResult {
  const handler = findMatchingHandler("network_timeout", tabId);
  if (!handler) return { matched: null, execute: {} };
  if (handler.action === "ignore") return { matched: handler, execute: {} };

  if (handler.action === "emit" && handler.options?.eventName) {
    emitToHub({
      sessionId: handler.sessionId,
      event: "network_timeout",
      queueName: handler.options.eventName,
      data,
      tabId,
    });
  }
  return { matched: handler, execute: {} };
}

/**
 * Get the network-timeout threshold that applies to a specific tab,
 * or null if no matching handler is registered.
 *
 * Respects handler precedence (tab-scoped wins over browser-wide),
 * same as `findMatchingHandler`. This is critical: a previous
 * implementation took the global minimum, which let a browser-wide
 * "2s" rule fire against a tab-scoped "10s" override. Threshold
 * selection must honor precedence or policies don't mean what they say.
 */
export function getNetworkTimeoutThresholdForTab(tabId: number): number | null {
  const h = findMatchingHandler("network_timeout", tabId);
  if (!h) return null;
  const t = h.options?.thresholdMs;
  return typeof t === "number" ? t : null;
}
