import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { IStateManager } from "../state-manager.js";
import type { Tool } from "./types.js";

const SelectBrowserArgs = z.object({
  browserId: z.string().describe("The browser ID to target (e.g. 'b1'). Use list_browsers to see available IDs."),
});

export function createBrowserTools(sm: IStateManager, getSessionId: () => string) {
  const listBrowsers: Tool = {
    schema: {
      name: "list_browsers",
      description:
        "List all connected browser instances. Each browser has a unique ID that can be used with select_browser to route tool commands to that browser.",
      inputSchema: zodToJsonSchema(z.object({})),
    },
    handle: async (context) => {
      const browsers = await sm.listBrowsers();
      if (browsers.length === 0) {
        return { content: [{ type: "text", text: "No browsers connected" }] };
      }
      const sessionBrowser = await sm.getSessionBrowser(getSessionId());
      const activeBrowserId = sessionBrowser ?? (context.activeBrowserId || undefined);
      const lines = browsers.map((b) => {
        const active = b.id === activeBrowserId ? " (active)" : "";
        const ago = Math.floor((Date.now() - b.connectedAt) / 1000);
        const duration = ago < 60 ? `${ago}s` : ago < 3600 ? `${Math.floor(ago / 60)}m` : `${Math.floor(ago / 3600)}h`;
        return `  ${b.id}: ${b.name}${active} — connected ${duration} ago`;
      });
      return {
        content: [{ type: "text", text: `Connected browsers (${browsers.length}):\n${lines.join("\n")}` }],
      };
    },
  };

  const selectBrowser: Tool = {
    schema: {
      name: "select_browser",
      description:
        "Set the active browser for this session. All subsequent tool commands will be routed to this browser. Use list_browsers to see available browser IDs.",
      inputSchema: zodToJsonSchema(SelectBrowserArgs),
    },
    handle: async (context, params) => {
      const { browserId } = SelectBrowserArgs.parse(params);
      const sessionId = getSessionId();

      await sm.selectBrowser(sessionId, browserId);

      // In hub mode, also update the context directly
      if (!context.isClientMode) {
        try {
          context.setActiveBrowser(browserId);
        } catch {
          // Context may not have this browser if we're in client mode
        }
      }

      const browsers = await sm.listBrowsers();
      const browser = browsers.find((b) => b.id === browserId);
      const name = browser?.name ?? browserId;

      return {
        content: [{ type: "text", text: `Active browser switched to "${name}" (${browserId})` }],
      };
    },
  };

  return { listBrowsers, selectBrowser };
}
