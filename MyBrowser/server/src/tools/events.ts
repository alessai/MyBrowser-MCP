// F1: browser_on — event-driven autonomous reactions.
//
// Registers event handlers in the hub's state manager and mirrors each
// registration to the target browser so the extension can act on events
// synchronously (dialogs need an immediate response). Handlers are
// session-scoped per codex: losing them on hub restart is the right
// default so recovery primitives don't turn into ambient policy.

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { IStateManager } from "../state-manager.js";
import type { Tool } from "./types.js";

const EventNames = ["dialog", "beforeunload", "new_tab", "network_timeout"] as const;
const ActionNames = ["dismiss", "accept", "emit", "ignore"] as const;

const HandlerOptionsSchema = z
  .object({
    promptText: z
      .string()
      .optional()
      .describe("For action=accept on prompt dialogs: the text to submit."),
    thresholdMs: z
      .number()
      .int()
      .positive()
      // Extension-side watchdog evicts pending-request entries after a
      // 5-minute TTL to bound memory. Keep well under that so slow
      // requests still fire their timeout event before eviction.
      .max(4 * 60 * 1000)
      .optional()
      .describe(
        "For event=network_timeout: the number of milliseconds a request " +
          "must remain pending before it's considered stuck. Max 240000 (4 minutes).",
      ),
    eventName: z
      .string()
      .optional()
      .describe(
        "For action=emit: the QUEUE NAME to push the event into (this " +
          "is an arbitrary string you pick; it is NOT the event kind). " +
          "browser_wait_for_event consumes events from the same queue " +
          "name, and queues are namespaced per-session so two sessions " +
          "can reuse names without colliding.",
      ),
    tabId: z
      .number()
      .optional()
      .describe(
        "Scope the handler to a specific tab. Omit for browser-wide.",
      ),
  })
  .optional();

const OnArgs = z
  .object({
    event: z.enum(EventNames).describe(
      "The event to react to. " +
        "'dialog' covers alert/confirm/prompt. 'beforeunload' is the unsaved-changes prompt. " +
        "'new_tab' fires when the browser opens a popup or target=_blank tab. " +
        "'network_timeout' fires when a request stays pending longer than thresholdMs.",
    ),
    action: z.enum(ActionNames).describe(
      "How to react. 'dismiss' closes/cancels. 'accept' confirms (with optional promptText). " +
        "'emit' pushes the event to a named queue (set options.eventName) for " +
        "browser_wait_for_event to consume. For dialogs, 'emit' ALSO implicitly " +
        "dismisses the dialog so the page can continue — semantics are 'notify AND dismiss'. " +
        "'ignore' is a no-op (useful to temporarily disable a broader handler while keeping the registration).",
    ),
    options: HandlerOptionsSchema,
    browserId: z
      .string()
      .optional()
      .describe("Target browser. Defaults to the active browser for this session."),
  })
  .superRefine((val, ctx) => {
    // Reject combinations that don't make semantic sense so the API
    // stays tight. Caller gets a clear error instead of a silent no-op.
    const { event, action, options } = val;

    // 'accept' only makes sense for dialog / beforeunload.
    // (new_tab has accept/dismiss → keep/close, handled below.)
    if (event === "network_timeout" && (action === "dismiss" || action === "accept")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "network_timeout has no synchronous response — use action='emit' (to notify) or 'ignore'.",
        path: ["action"],
      });
    }

    // new_tab: only dismiss (close), ignore, or emit make sense.
    if (event === "new_tab" && action === "accept") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "new_tab + accept is redundant (tabs are accepted by default). Use 'dismiss' to close, 'emit' to notify, or 'ignore'.",
        path: ["action"],
      });
    }

    // promptText only meaningful for dialog + accept.
    if (options?.promptText !== undefined) {
      if (event !== "dialog" || action !== "accept") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "options.promptText is only valid for event='dialog' + action='accept'.",
          path: ["options", "promptText"],
        });
      }
    }

    // thresholdMs only meaningful for network_timeout.
    if (options?.thresholdMs !== undefined && event !== "network_timeout") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "options.thresholdMs is only valid for event='network_timeout'.",
        path: ["options", "thresholdMs"],
      });
    }

    // eventName (queue name) only meaningful for action=emit.
    if (options?.eventName !== undefined && action !== "emit") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "options.eventName is only valid for action='emit'.",
        path: ["options", "eventName"],
      });
    }

    // Required fields for specific combinations.
    if (action === "emit" && !options?.eventName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "action='emit' requires options.eventName (the queue name).",
        path: ["options", "eventName"],
      });
    }
    if (event === "network_timeout" && !options?.thresholdMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "event='network_timeout' requires options.thresholdMs (milliseconds).",
        path: ["options", "thresholdMs"],
      });
    }
  });

const OffArgs = z.object({
  handlerId: z
    .string()
    .optional()
    .describe(
      "The specific handler to remove. Omit to remove ALL handlers this session has registered " +
        "(across every browser, not just the active one).",
    ),
});

const ListArgs = z.object({
  browserId: z
    .string()
    .optional()
    .describe("Filter to a specific browser. Omit for all browsers."),
});

const WaitForEventArgs = z.object({
  eventName: z.string().describe(
    "The queue name to wait on. Must match the eventName in an earlier browser_on(action='emit') call.",
  ),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .default(30_000)
    .describe("Max wait in milliseconds (default 30s). Returns {ok:false, reason:'timeout'} on expiry."),
});

export function createEventsTools(
  sm: IStateManager,
  getSessionId: () => string,
  getActiveBrowser: () => Promise<string>,
): {
  browserOn: Tool;
  browserOff: Tool;
  browserEventsList: Tool;
  browserWaitForEvent: Tool;
} {
  const browserOn: Tool = {
    schema: {
      name: "browser_on",
      description:
        "Register an autonomous reaction to a browser event. For example, browser_on('dialog', 'dismiss') " +
        "auto-closes every alert/confirm/prompt so unattended flows don't stall. " +
        "Use action='emit' with options.eventName to push events into a named queue you can consume " +
        "later with browser_wait_for_event. Handlers are session-scoped and cleared on browser disconnect.",
      inputSchema: zodToJsonSchema(OnArgs),
    },
    handle: async (context, params) => {
      const args = OnArgs.parse(params);
      const sessionId = getSessionId();
      const browserId = args.browserId ?? (await getActiveBrowser());

      const handler = await sm.registerEventHandler(
        sessionId,
        browserId,
        args.event,
        args.action,
        args.options,
      );

      // Mirror the registration to the target browser so the extension
      // can react synchronously. Use the browser-targeted send so a
      // handler registered for browser B doesn't accidentally get
      // mirrored onto browser A (the session's active browser) in
      // multi-browser setups.
      try {
        await context.sendSocketMessageToBrowser(
          browserId,
          "browser_register_handler",
          { handler },
        );
      } catch (e) {
        // If the push fails we still keep the hub-side registration so
        // reconnect can replay it. Just surface the error to the caller.
        return {
          content: [
            {
              type: "text",
              text: `Handler stored but not yet pushed to the browser: ${
                e instanceof Error ? e.message : String(e)
              }. Re-run browser_on after the browser reconnects.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Registered handler ${handler.id}: ${args.event} → ${args.action}${
              args.options?.eventName ? ` (queue: ${args.options.eventName})` : ""
            }${args.options?.thresholdMs ? ` (threshold: ${args.options.thresholdMs}ms)` : ""}`,
          },
        ],
      };
    },
  };

  const browserOff: Tool = {
    schema: {
      name: "browser_off",
      description:
        "Unregister an event handler. Pass handlerId to remove a specific one, or omit to remove ALL handlers this session registered (across every browser).",
      inputSchema: zodToJsonSchema(OffArgs),
    },
    handle: async (context, params) => {
      const args = OffArgs.parse(params ?? {});
      const sessionId = getSessionId();

      if (args.handlerId) {
        // Look up the handler FIRST so we know which browser to push
        // the unregister message to. Then remove it from the registry.
        // Order matters: if we removed first, we'd lose the browserId
        // and push to the wrong extension.
        const existing = (await sm.listEventHandlers(sessionId)).find(
          (h) => h.id === args.handlerId,
        );
        if (!existing) {
          return {
            content: [
              {
                type: "text",
                text: `Handler ${args.handlerId} not found or not owned by this session`,
              },
            ],
            isError: true,
          };
        }
        const removed = await sm.unregisterEventHandler(
          sessionId,
          args.handlerId,
        );
        if (!removed) {
          return {
            content: [
              {
                type: "text",
                text: `Handler ${args.handlerId} already removed`,
              },
            ],
            isError: true,
          };
        }
        try {
          await context.sendSocketMessageToBrowser(
            existing.browserId,
            "browser_unregister_handler",
            { handlerId: args.handlerId },
          );
        } catch {
          /* best-effort — hub state is authoritative */
        }
        return {
          content: [{ type: "text", text: `Removed handler ${args.handlerId}` }],
        };
      }

      // No id → clear everything THIS SESSION registered.
      // `clearEventHandlersForSession` internally broadcasts the
      // session-scoped unregister to all connected browsers via the
      // state manager's broadcaster, so we don't need a separate
      // `context.sendSocketMessage` push here.
      const existing = await sm.listEventHandlers(sessionId);
      await sm.clearEventHandlersForSession(sessionId);
      return {
        content: [
          {
            type: "text",
            text: `Cleared ${existing.length} handler${existing.length === 1 ? "" : "s"} for this session`,
          },
        ],
      };
    },
  };

  const browserEventsList: Tool = {
    schema: {
      name: "browser_events_list",
      description:
        "List currently-registered event handlers. Use before browser_off to find handler IDs, or to audit what auto-reactions are active in a session.",
      inputSchema: zodToJsonSchema(ListArgs),
    },
    handle: async (_context, params) => {
      const args = ListArgs.parse(params ?? {});
      const sessionId = getSessionId();
      // Only lists handlers registered by THIS session — one session
      // cannot enumerate another session's handlers.
      const handlers = await sm.listEventHandlers(sessionId, args.browserId);
      if (handlers.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: args.browserId
                ? `No event handlers for browser ${args.browserId}`
                : "No event handlers registered",
            },
          ],
        };
      }
      const lines = handlers.map((h) => {
        const extras: string[] = [];
        if (h.options?.eventName) extras.push(`queue=${h.options.eventName}`);
        if (h.options?.thresholdMs) extras.push(`threshold=${h.options.thresholdMs}ms`);
        if (h.options?.tabId !== undefined) extras.push(`tab=${h.options.tabId}`);
        return `  ${h.id}  [${h.browserId}]  ${h.event} → ${h.action}${
          extras.length ? ` (${extras.join(", ")})` : ""
        }`;
      });
      return {
        content: [
          {
            type: "text",
            text: `${handlers.length} handler${handlers.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
          },
        ],
      };
    },
  };

  const browserWaitForEvent: Tool = {
    schema: {
      name: "browser_wait_for_event",
      description:
        "Wait for an event to arrive in a named queue. Pair with browser_on(action='emit', options.eventName='...') " +
        "to observe events without blocking the whole flow. Returns the event data when one arrives, or " +
        "{ok:false, reason:'timeout'} after timeoutMs (default 30s).",
      inputSchema: zodToJsonSchema(WaitForEventArgs),
    },
    handle: async (_context, params) => {
      const args = WaitForEventArgs.parse(params);
      const sessionId = getSessionId();
      // Queue reads are scoped to this session — you can only consume
      // events that were emitted into YOUR session's queue namespace.
      const result = await sm.waitForEvent(
        sessionId,
        args.eventName,
        args.timeoutMs,
      );
      if (!result.ok) {
        return {
          content: [
            {
              type: "text",
              text: `No event received within ${args.timeoutMs}ms (queue: ${args.eventName})`,
            },
          ],
        };
      }
      const e = result.event;
      return {
        content: [
          {
            type: "text",
            text:
              `Event received on queue "${args.eventName}":\n` +
              `  type: ${e.event}\n` +
              `  browser: ${e.browserId}\n` +
              (e.tabId !== undefined ? `  tab: ${e.tabId}\n` : "") +
              `  age: ${Date.now() - e.receivedAt}ms\n` +
              `  data: ${JSON.stringify(e.data)}`,
          },
        ],
      };
    },
  };

  return { browserOn, browserOff, browserEventsList, browserWaitForEvent };
}
