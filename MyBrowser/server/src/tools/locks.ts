// F3: browser_lock / browser_unlock / browser_locks_list
//
// Named mutex primitive for multi-agent coordination. Tab-level
// ownership handles the common case; locks cover named critical
// sections that span multiple tabs or non-DOM resources (shared API
// quotas, billing flows, single-writer invariants).
//
// Semantics:
//   - Non-reentrant: a session that already holds the lock cannot
//     re-acquire it. Returns an immediate error instead of self-
//     deadlocking, giving LLM callers an actionable signal.
//   - FIFO waiter queue, promise-based (no busy polling).
//   - Optional TTL for hands-off auto-release (default: none).
//     Expired locks are immediately reclaimable by any session.
//   - Auto-released when the owning session disconnects.
//   - browser_unlock fails for non-owners.

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { IStateManager } from "../state-manager.js";
import type { Tool } from "./types.js";

// Names are caller-chosen but we restrict the character set so they
// fit cleanly in log lines and error messages.
const LOCK_NAME_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

const LockArgs = z.object({
  name: z
    .string()
    .refine((v) => LOCK_NAME_RE.test(v), {
      message:
        "Lock name must be 1-128 chars, alphanumeric + _ . : - (no slashes or spaces)",
    })
    .describe(
      "Lock name. Pick a stable identifier for the resource you're guarding " +
        "(e.g. 'checkout.payment', 'inventory:sku-42'). Up to 128 chars.",
    ),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(10 * 60 * 1000)
    .optional()
    .default(30_000)
    .describe(
      "Max milliseconds to wait for the lock. Default 30s, max 10 minutes. " +
        "Returns {acquired:false, reason:'timeout'} if the wait expires.",
    ),
  ttlMs: z
    .number()
    .int()
    .positive()
    .max(60 * 60 * 1000)
    .optional()
    .describe(
      "Optional auto-release TTL. If set, the lock releases itself after " +
        "this many milliseconds even if the owner doesn't call browser_unlock. " +
        "Max 1 hour. Useful as a crash-recovery safety net.",
    ),
});

const UnlockArgs = z.object({
  name: z
    .string()
    .refine((v) => LOCK_NAME_RE.test(v), {
      message:
        "Lock name must be 1-128 chars, alphanumeric + _ . : - (no slashes or spaces)",
    })
    .describe("The lock name to release. Must be the same name passed to browser_lock."),
});

const ListArgs = z.object({});

export function createLockTools(
  sm: IStateManager,
  getSessionId: () => string,
): {
  browserLock: Tool;
  browserUnlock: Tool;
  browserLocksList: Tool;
} {
  const browserLock: Tool = {
    schema: {
      name: "browser_lock",
      description:
        "Acquire a named mutex for coordinating multi-agent critical sections beyond tab ownership. " +
        "Non-reentrant: a session that already holds the lock cannot re-acquire it (returns error). " +
        "FIFO fairness: waiters are granted in the order they queued. " +
        "Optional ttlMs for crash-recovery auto-release. " +
        "Auto-released when the session disconnects.",
      inputSchema: zodToJsonSchema(LockArgs),
    },
    handle: async (_context, params) => {
      const args = LockArgs.parse(params ?? {});
      const sessionId = getSessionId();
      const result = await sm.acquireLock(
        sessionId,
        args.name,
        args.timeoutMs,
        args.ttlMs,
      );
      if (!result.acquired) {
        return {
          content: [
            {
              type: "text",
              text:
                `Lock "${args.name}" NOT acquired: ${result.reason}` +
                (result.owner ? ` (current owner: ${result.owner})` : "") +
                (result.expiresAt
                  ? ` (holder expires in ${Math.max(
                      0,
                      result.expiresAt - Date.now(),
                    )}ms)`
                  : ""),
            },
          ],
          isError: result.reason !== "timeout" && result.reason !== "already held by this session",
        };
      }
      const lock = result.lock;
      return {
        content: [
          {
            type: "text",
            text:
              `Acquired lock "${lock.name}"` +
              (lock.expiresAt
                ? ` (auto-release at ${new Date(lock.expiresAt).toISOString()})`
                : "") +
              `. Remember to call browser_unlock when done.`,
          },
        ],
      };
    },
  };

  const browserUnlock: Tool = {
    schema: {
      name: "browser_unlock",
      description:
        "Release a named lock previously acquired with browser_lock. Fails if the caller is not the current owner.",
      inputSchema: zodToJsonSchema(UnlockArgs),
    },
    handle: async (_context, params) => {
      const args = UnlockArgs.parse(params ?? {});
      const sessionId = getSessionId();
      const result = await sm.releaseLock(sessionId, args.name);
      if (!result.released) {
        return {
          content: [
            {
              type: "text",
              text: `Could not release lock "${args.name}": ${result.reason}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Released lock "${args.name}"`,
          },
        ],
      };
    },
  };

  const browserLocksList: Tool = {
    schema: {
      name: "browser_locks_list",
      description:
        "List all currently-held locks. Shows name, owner session id, acquisition time, and TTL expiry (if any).",
      inputSchema: zodToJsonSchema(ListArgs),
    },
    handle: async () => {
      const locks = await sm.listLocks();
      if (locks.length === 0) {
        return { content: [{ type: "text", text: "No locks currently held" }] };
      }
      const now = Date.now();
      const lines = locks.map((l) => {
        const age = Math.round((now - l.acquiredAt) / 1000);
        const ttl = l.expiresAt
          ? ` (expires in ${Math.max(0, Math.round((l.expiresAt - now) / 1000))}s)`
          : "";
        return `  ${l.name}  owner=${l.owner}  held ${age}s${ttl}`;
      });
      return {
        content: [
          {
            type: "text",
            text: `${locks.length} lock${locks.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
          },
        ],
      };
    },
  };

  return { browserLock, browserUnlock, browserLocksList };
}
