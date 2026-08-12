import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { IStateManager } from "../state-manager.js";
import type { Tool } from "./types.js";

const SelectBrowserArgs = z.object({
  browserId: z.string().describe("The browser ID to target (e.g. 'b1'). Use list_browsers to see available IDs."),
});

const SetDefaultBrowserArgs = z.object({
  browserId: z.string().describe("The currently connected browser ID to save as the shared default. The browser's name is persisted, not the ephemeral ID."),
});

const EmptyArgs = z.object({});

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
      const sessionId = getSessionId();
      const [sessionBrowser, defaultBrowser, resolution] = await Promise.all([
        sm.getSessionBrowser(sessionId),
        sm.getDefaultBrowser(),
        sm.resolveBrowserTarget(sessionId),
      ]);
      const effectiveBrowserId = resolution.ok ? resolution.browserId : undefined;
      const lines = browsers.map((b) => {
        const markers: string[] = [];
        if (b.id === sessionBrowser) markers.push("session");
        if (b.id === defaultBrowser.resolvedBrowserId) markers.push("default");
        if (b.id === effectiveBrowserId) markers.push("active");
        const markerText = markers.length > 0 ? ` (${markers.join(", ")})` : "";
        const ago = Math.floor((Date.now() - b.connectedAt) / 1000);
        const duration = ago < 60 ? `${ago}s` : ago < 3600 ? `${Math.floor(ago / 60)}m` : `${Math.floor(ago / 3600)}h`;
        return `  ${b.id}: ${b.name}${markerText} — connected ${duration} ago`;
      });
      const footer: string[] = [];
      if (defaultBrowser.status === "connected") {
        footer.push(`Default: ${defaultBrowser.defaultBrowserName} (${defaultBrowser.resolvedBrowserId})`);
      } else if (defaultBrowser.defaultBrowserName) {
        footer.push(`Default: ${defaultBrowser.defaultBrowserName} (${defaultBrowser.status})`);
      } else {
        footer.push("Default: not set");
      }
      if (!resolution.ok) footer.push(`Routing: ${resolution.message}`);
      return {
        content: [{ type: "text", text: `Connected browsers (${browsers.length}):\n${lines.join("\n")}\n${footer.join("\n")}` }],
      };
    },
  };

  const selectBrowser: Tool = {
    schema: {
      name: "select_browser",
      description:
        "Set the active browser for this session. Use only when the user explicitly asked for a non-default browser. The override lasts until use_default_browser, browser_cleanup, session closure, or 30 minutes of tool inactivity.",
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

  const useDefaultBrowser: Tool = {
    schema: {
      name: "use_default_browser",
      description:
        "Clear this session's browser override and return routing to the shared default browser.",
      inputSchema: zodToJsonSchema(EmptyArgs),
    },
    handle: async (context) => {
      const sessionId = getSessionId();
      await sm.clearSessionBrowser(sessionId);
      const resolution = await sm.resolveBrowserTarget(sessionId);
      if (!resolution.ok) {
        return {
          content: [{
            type: "text",
            text: `Session browser override cleared. Routing now fails closed: ${resolution.message}`,
          }],
        };
      }
      if (!context.isClientMode) context.setActiveBrowser(resolution.browserId);
      return {
        content: [{
          type: "text",
          text: `Session now follows the shared default browser "${resolution.browserName}" (${resolution.browserId}).`,
        }],
      };
    },
  };

  const setDefaultBrowser: Tool = {
    schema: {
      name: "set_default_browser",
      description:
        "Save a shared default browser by stable browser name. Use this when multiple browsers are connected and you want future tool calls to prefer one browser unless a session-specific select_browser override is set.",
      inputSchema: zodToJsonSchema(SetDefaultBrowserArgs),
    },
    handle: async (context, params) => {
      const { browserId } = SetDefaultBrowserArgs.parse(params);
      const info = await sm.setDefaultBrowser(browserId);
      await sm.clearSessionBrowser(getSessionId());
      const name = info.resolvedBrowserName ?? info.defaultBrowserName ?? browserId;
      const resolvedId = info.resolvedBrowserId ?? browserId;
      if (!context.isClientMode && info.resolvedBrowserId) {
        context.setActiveBrowser(info.resolvedBrowserId);
      }
      return {
        content: [{
          type: "text",
          text: `Default browser set to "${name}" (${resolvedId}). This stores the browser name, not the temporary ID. This session now follows the new shared default.`,
        }],
      };
    },
  };

  const getDefaultBrowser: Tool = {
    schema: {
      name: "get_default_browser",
      description:
        "Show the shared default browser preference and whether it currently resolves to a connected browser.",
      inputSchema: zodToJsonSchema(EmptyArgs),
    },
    handle: async () => {
      const info = await sm.getDefaultBrowser();
      return {
        content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
      };
    },
  };

  const clearDefaultBrowser: Tool = {
    schema: {
      name: "clear_default_browser",
      description:
        "Clear the shared default browser preference. After clearing, routing falls back to a session selection or auto-selects only when exactly one browser is connected.",
      inputSchema: zodToJsonSchema(EmptyArgs),
    },
    handle: async () => {
      await sm.clearDefaultBrowser();
      return {
        content: [{ type: "text", text: "Default browser cleared." }],
      };
    },
  };

  return {
    listBrowsers,
    selectBrowser,
    useDefaultBrowser,
    setDefaultBrowser,
    getDefaultBrowser,
    clearDefaultBrowser,
  };
}
