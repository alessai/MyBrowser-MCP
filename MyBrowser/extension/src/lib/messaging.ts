// Typed message bus for communication between:
// - Service Worker <-> Content Script (via chrome.tabs.sendMessage / chrome.runtime.sendMessage)
// - Service Worker <-> Offscreen Document (via chrome.runtime.sendMessage)

interface MessageEnvelope {
  type: string;
  payload?: unknown;
}

interface ErrorResponse {
  __error: true;
  message: string;
}

function isErrorResponse(val: unknown): val is ErrorResponse {
  return (
    typeof val === 'object' &&
    val !== null &&
    '__error' in val &&
    (val as ErrorResponse).__error === true
  );
}

function makeError(e: unknown): ErrorResponse {
  const message =
    e instanceof Error ? e.message : typeof e === 'string' ? e : String(e);
  return { __error: true, message };
}

/**
 * Send a typed message to the service worker (from content script or offscreen doc).
 */
export async function sendToBackground<T = unknown>(
  type: string,
  payload?: unknown,
): Promise<T> {
  const msg: MessageEnvelope = { type, payload };
  const response = await chrome.runtime.sendMessage(msg);
  if (isErrorResponse(response)) throw new Error(response.message);
  return response as T;
}

/**
 * Send a typed message to a specific tab's content script.
 * Times out after 10s if content script doesn't respond (dead or not injected).
 */
export async function sendToTab<T = unknown>(
  tabId: number,
  type: string,
  payload?: unknown,
  timeoutMs = 10000,
): Promise<T> {
  const msg: MessageEnvelope = { type, payload };
  const response = await Promise.race([
    chrome.tabs.sendMessage(tabId, msg),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Content script timeout (${type}) after ${timeoutMs}ms — tab ${tabId} may need re-injection`)), timeoutMs),
    ),
  ]);
  if (isErrorResponse(response)) throw new Error(response.message);
  return response as T;
}

type MessageHandler = (
  envelope: MessageEnvelope,
  sender: chrome.runtime.MessageSender,
) => Promise<unknown>;

/**
 * Register a message handler for a specific message type.
 * Returns a cleanup function to remove the listener.
 */
export function addMessageHandler(
  type: string,
  handler: (payload: unknown, sender: chrome.runtime.MessageSender) => Promise<unknown>,
  options?: { requiredSenderTabId?: number },
): () => void {
  const listener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean => {
    const msg = message as MessageEnvelope;
    if (msg.type !== type) return false;
    if (options?.requiredSenderTabId && sender.tab?.id !== options.requiredSenderTabId)
      return false;

    handler(msg.payload, sender)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse(makeError(err)));
    return true; // Will respond asynchronously
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

/**
 * Create a typed message sender function (convenience wrapper for content script messages).
 */
export function createMessageSender(type: string) {
  return async <T = unknown>(payload: unknown, tabId?: number | null): Promise<T> => {
    if (tabId === undefined || tabId === null) {
      return sendToBackground<T>(type, payload);
    }
    return sendToTab<T>(tabId, type, payload);
  };
}
