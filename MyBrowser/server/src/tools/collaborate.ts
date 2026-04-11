import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { makeTabKey, type IStateManager } from "../state-manager.js";
import type { Tool } from "./types.js";

const HandoffArgs = z.object({
  tabId: z.number().describe("The tab ID to hand off"),
  browserId: z.string().optional().describe("Browser ID. Defaults to active browser."),
  toSession: z.string().describe("Target session ID or name to transfer ownership to"),
  message: z.string().optional().describe("Optional message to accompany the handoff"),
});

const SharedGetArgs = z.object({
  key: z.string().describe("The key to read from shared state"),
});

const SharedSetArgs = z.object({
  key: z.string().describe("The key to write to shared state"),
  value: z.unknown().describe("The value to store (any JSON-serializable value)"),
});

const SharedDeleteArgs = z.object({
  key: z.string().describe("The key to delete from shared state"),
});

export function createCollaborateTools(sm: IStateManager, getSessionId: () => string, getActiveBrowser: () => Promise<string>) {
  const handoff: Tool = {
    schema: {
      name: "browser_handoff",
      description:
        "Transfer ownership of a tab to another session. The current session must own the tab. Use browser_sessions to discover session IDs.",
      inputSchema: zodToJsonSchema(HandoffArgs),
    },
    handle: async (context, params) => {
      const { tabId, browserId: explicitBrowser, toSession, message } = HandoffArgs.parse(params);
      const fromSessionId = getSessionId();
      const browserId = explicitBrowser ?? await getActiveBrowser();
      const tabKey = makeTabKey(browserId, tabId);

      const currentOwner = await sm.getTabOwner(tabKey);
      if (currentOwner !== fromSessionId) {
        return {
          content: [{ type: "text", text: `Cannot hand off tab ${tabId} on ${browserId}: this session does not own it` }],
          isError: true,
        };
      }

      // Resolve target by ID or name
      let targetId = toSession;
      const allSessions = await sm.listSessions();
      const byDirect = allSessions.find((s) => s.id === toSession);
      if (!byDirect) {
        const byName = allSessions.find((s) => s.name === toSession);
        if (byName) {
          targetId = byName.id;
        } else {
          return {
            content: [{ type: "text", text: `Target session "${toSession}" not found. Use browser_sessions to list active sessions.` }],
            isError: true,
          };
        }
      }

      const transferred = await sm.transferTab(fromSessionId, targetId, tabKey);
      if (!transferred) {
        return {
          content: [{ type: "text", text: `Failed to hand off tab ${tabId} on ${browserId} to "${toSession}"` }],
          isError: true,
        };
      }

      const fromName = await sm.getSessionName(fromSessionId) ?? fromSessionId;
      const toName = await sm.getSessionName(targetId) ?? targetId;
      const msgSuffix = message ? ` Message: ${message}` : "";
      return {
        content: [{ type: "text", text: `Tab ${tabId} on ${browserId} handed off from "${fromName}" to "${toName}".${msgSuffix}` }],
      };
    },
  };

  const sharedGet: Tool = {
    schema: {
      name: "browser_shared_get",
      description: "Read a value from the shared inter-session key-value store.",
      inputSchema: zodToJsonSchema(SharedGetArgs),
    },
    handle: async (_context, params) => {
      const { key } = SharedGetArgs.parse(params);
      const value = await sm.sharedGet(key);
      if (value === undefined) {
        return {
          content: [{ type: "text", text: `Key "${key}" not found in shared state` }],
          isError: true,
        };
      }
      let text: string;
      try {
        text = JSON.stringify(value, null, 2);
      } catch {
        text = String(value);
      }
      return { content: [{ type: "text", text }] };
    },
  };

  const sharedSet: Tool = {
    schema: {
      name: "browser_shared_set",
      description: "Write a value to the shared inter-session key-value store. Other sessions can read it with browser_shared_get.",
      inputSchema: zodToJsonSchema(SharedSetArgs),
    },
    handle: async (_context, params) => {
      const { key, value } = SharedSetArgs.parse(params);
      await sm.sharedSet(key, value);
      return { content: [{ type: "text", text: `Stored key "${key}" in shared state` }] };
    },
  };

  const sharedDelete: Tool = {
    schema: {
      name: "browser_shared_delete",
      description: "Delete a key from the shared inter-session key-value store.",
      inputSchema: zodToJsonSchema(SharedDeleteArgs),
    },
    handle: async (_context, params) => {
      const { key } = SharedDeleteArgs.parse(params);
      const deleted = await sm.sharedDelete(key);
      if (deleted) {
        return { content: [{ type: "text", text: `Deleted key "${key}" from shared state` }] };
      }
      return {
        content: [{ type: "text", text: `Key "${key}" not found in shared state` }],
        isError: true,
      };
    },
  };

  const sharedList: Tool = {
    schema: {
      name: "browser_shared_list",
      description: "List all keys in the shared inter-session key-value store with their types and value previews.",
      inputSchema: zodToJsonSchema(z.object({})),
    },
    handle: async () => {
      const entries = await sm.sharedList();
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "Shared state is empty" }] };
      }
      const lines = entries.map((e) => `  ${e.key} (${e.type}): ${e.preview}`);
      return {
        content: [{ type: "text", text: `Shared state (${entries.length} keys):\n${lines.join("\n")}` }],
      };
    },
  };

  return { handoff, sharedGet, sharedSet, sharedDelete, sharedList };
}
