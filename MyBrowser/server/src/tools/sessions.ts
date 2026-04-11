import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { makeTabKey, type IStateManager } from "../state-manager.js";
import type { Tool } from "./types.js";

const ClaimTabArgs = z.object({
  tabId: z.number().describe("The tab ID to claim ownership of"),
  browserId: z.string().optional().describe("Browser ID (from list_browsers). Defaults to active browser."),
});

const ReleaseTabArgs = z.object({
  tabId: z.number().describe("The tab ID to release ownership of"),
  browserId: z.string().optional().describe("Browser ID. Defaults to active browser."),
});

export function createSessionTools(sm: IStateManager, getSessionId: () => string, getActiveBrowser: () => Promise<string>) {
  const claimTab: Tool = {
    schema: {
      name: "browser_claim_tab",
      description:
        "Claim exclusive ownership of a browser tab. Other sessions will not be able to perform mutating actions on this tab until it is released. Only needed in multi-session setups.",
      inputSchema: zodToJsonSchema(ClaimTabArgs),
    },
    handle: async (context, params) => {
      const { tabId, browserId: explicitBrowser } = ClaimTabArgs.parse(params);
      const sessionId = getSessionId();
      const browserId = explicitBrowser ?? await getActiveBrowser();
      const tabKey = makeTabKey(browserId, tabId);

      const result = await sm.claimTab(sessionId, tabKey);
      if (result.ok) {
        const name = await sm.getSessionName(sessionId) ?? sessionId;
        return {
          content: [{ type: "text", text: `Tab ${tabId} on browser ${browserId} claimed by session "${name}"` }],
        };
      }
      const ownerName = result.owner
        ? (await sm.getSessionName(result.owner) ?? result.owner)
        : "unknown";
      return {
        content: [{ type: "text", text: `Tab ${tabId} on browser ${browserId} is already owned by session "${ownerName}". Ask them to release it first.` }],
        isError: true,
      };
    },
  };

  const releaseTab: Tool = {
    schema: {
      name: "browser_release_tab",
      description:
        "Release ownership of a browser tab so other sessions can claim or use it.",
      inputSchema: zodToJsonSchema(ReleaseTabArgs),
    },
    handle: async (context, params) => {
      const { tabId, browserId: explicitBrowser } = ReleaseTabArgs.parse(params);
      const sessionId = getSessionId();
      const browserId = explicitBrowser ?? await getActiveBrowser();
      const tabKey = makeTabKey(browserId, tabId);

      const released = await sm.releaseTab(sessionId, tabKey);
      if (released) {
        return { content: [{ type: "text", text: `Tab ${tabId} on browser ${browserId} released` }] };
      }
      return {
        content: [{ type: "text", text: `Tab ${tabId} on browser ${browserId} is not owned by this session` }],
        isError: true,
      };
    },
  };

  const sessions: Tool = {
    schema: {
      name: "browser_sessions",
      description:
        "List all active MCP sessions, their owned tabs, and target browser. Useful for understanding who is working on what in a multi-agent setup.",
      inputSchema: zodToJsonSchema(z.object({})),
    },
    handle: async () => {
      const list = await sm.listSessions();
      if (list.length === 0) {
        return { content: [{ type: "text", text: "No active sessions" }] };
      }
      const lines = list.map((s) => {
        const tabs = s.ownedTabs.length > 0 ? `tabs: [${s.ownedTabs.join(", ")}]` : "no owned tabs";
        const browser = s.activeBrowserId ? `browser: ${s.activeBrowserId}` : "no browser selected";
        return `  ${s.name} (${s.id}) — ${tabs} — ${browser} — last active: ${new Date(s.lastActivity).toISOString()}`;
      });
      return {
        content: [{ type: "text", text: `Active sessions (${list.length}):\n${lines.join("\n")}` }],
      };
    },
  };

  return { claimTab, releaseTab, sessions };
}
