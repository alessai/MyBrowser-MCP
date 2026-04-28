import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Context } from "./context.js";
import { createWebSocketServer } from "./ws-server.js";
import { makeTabKey, type IStateManager } from "./state-manager.js";
import type { Tool } from "./tools/types.js";
import { recordIssue } from "./logger.js";

// Navigation tools
import { navigate, goBack, goForward, wait } from "./tools/navigation.js";

// Input tools
import { click, type, hover, pressKey, drag, selectOption } from "./tools/input.js";

// Snapshot tools
import { snapshot } from "./tools/snapshot.js";

// Media tools
import { screenshot, getConsoleLogs } from "./tools/media.js";

// Tab tools
import { listTabs, selectTab, newTab, closeTab } from "./tools/tabs.js";

// ULTRA tools
import { extract } from "./tools/extract.js";
import { find } from "./tools/find.js";
import { fillForm } from "./tools/form.js";
import { action } from "./tools/action.js";
import { waitFor, assert } from "./tools/waitfor.js";

// ULTRA Phase 3: Site knowledge tools
import { learn, siteInfo } from "./tools/learn.js";
import { ensureDirectories } from "./site-knowledge.js";

// ULTRA Phase 3: Recording tools
import { recordStart, recordStop, recordList } from "./tools/record.js";

// ULTRA Phase 3: Replay tools
import { replay } from "./tools/replay.js";

// ULTRA Phase 4: Session tools
import { createSessionTools } from "./tools/sessions.js";

// ULTRA Phase 4: Collaboration tools
import { createCollaborateTools } from "./tools/collaborate.js";

// Browser management tools
import { createBrowserTools } from "./tools/browser.js";

// ULTRA Phase 5: Eval & Storage tools
import { browserEval } from "./tools/eval.js";
import { browserStorage } from "./tools/storage.js";

// ULTRA Phase 5: Network & Performance tools
import { network } from "./tools/network.js";
import { performance } from "./tools/performance.js";

// ULTRA: File & Clipboard tools
import { upload } from "./tools/upload.js";
import { download } from "./tools/download.js";
import { clipboard } from "./tools/clipboard.js";

// Annotated notes (user-initiated visual feedback inbox)
import { createNotesTools } from "./tools/notes.js";
import { ensureNotesDirectories } from "./notes.js";

// F1: event-driven autonomous reactions (browser_on / browser_off / ...)
import { createEventsTools } from "./tools/events.js";

// F3: named mutex (browser_lock / browser_unlock / ...)
import { createLockTools } from "./tools/locks.js";

// Diagnostics and support bundle tools
import { createDiagnosticsTools } from "./tools/diagnostics.js";

export interface ServerOptions {
  host: string;
  port: number;
  token: string;
  sessionId?: string;
  sessionName?: string;
}

export let stateManager: IStateManager;

/**
 * Tools that mutate tab state. Subject to ownership checks.
 */
const MUTATING_TOOLS = new Set([
  "browser_navigate", "browser_go_back", "browser_go_forward",
  "browser_click", "browser_type", "browser_hover", "browser_press_key",
  "browser_drag", "browser_select_option",
  "select_tab", "close_tab",
  "browser_fill_form", "browser_action",
  "browser_record_start", "browser_record_stop", "browser_replay",
  "browser_eval", "browser_storage", "browser_upload", "browser_clipboard",
]);

function generateSessionId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const timestamp = Date.now().toString(36);
  const randomStr = Math.random().toString(36).substring(2, 10);
  return `${timestamp}-${randomStr}`;
}

function extractTabId(args: unknown): number | undefined {
  if (args && typeof args === "object" && "tabId" in args) {
    const val = (args as Record<string, unknown>).tabId;
    if (typeof val === "number") return val;
  }
  return undefined;
}

export async function createServerWithTools(options: ServerOptions) {
  const { host, port, token } = options;
  const context = new Context();

  const sessionId = options.sessionId ?? generateSessionId();
  context.sessionId = sessionId;

  ensureDirectories();
  ensureNotesDirectories();

  const wss = await createWebSocketServer({ host, port, token, context });
  stateManager = wss.stateManager;

  await stateManager.registerSession(sessionId, options.sessionName);

  // Re-register session on hub reconnect (client mode only)
  wss.onReconnect?.(() => stateManager.registerSession(sessionId, options.sessionName));

  // Helper to get the active browser for this session (for composite tab keys)
  const getActiveBrowser = async (): Promise<string> => {
    // Check if this session has explicitly selected a browser
    const sessionBrowser = await stateManager.getSessionBrowser(sessionId);
    if (sessionBrowser) return sessionBrowser;
    // Hub mode: use context's active browser (set by this session's select_browser)
    if (!context.isClientMode && context.activeBrowserId) return context.activeBrowserId;
    // Auto-select if exactly one browser is connected
    const browsers = await stateManager.listBrowsers();
    if (browsers.length === 1) return browsers[0]!.id;
    if (browsers.length === 0) throw new Error("No browser connected");
    throw new Error("Multiple browsers connected. Use list_browsers and select_browser to choose one.");
  };

  // Create tool sets
  const { claimTab, releaseTab, sessions } = createSessionTools(stateManager, () => sessionId, getActiveBrowser);
  const { handoff, sharedGet, sharedSet, sharedDelete, sharedList } = createCollaborateTools(stateManager, () => sessionId, getActiveBrowser);
  const { listBrowsers, selectBrowser } = createBrowserTools(stateManager, () => sessionId);
  const { notesList, notesGet, notesArchive, notesUnarchive, notesDelete } = createNotesTools(stateManager);
  const { browserOn, browserOff, browserEventsList, browserWaitForEvent } = createEventsTools(stateManager, () => sessionId, getActiveBrowser);
  const { browserLock, browserUnlock, browserLocksList } = createLockTools(stateManager, () => sessionId);
  const { browserDiagnostics, browserSupportBundle } = createDiagnosticsTools({
    stateManager,
    context,
    getActiveBrowser,
    serverInfo: {
      version: "1.1.1",
      host,
      port,
      sessionId,
      sessionName: options.sessionName,
      isHub: wss.isHub,
    },
  });

  const tools: Tool[] = [
    // Navigation (with auto-snapshot)
    navigate(true), goBack(true), goForward(true), wait,
    // Input
    click, type, hover, pressKey, drag, selectOption,
    // Snapshot
    snapshot,
    // Media
    screenshot, getConsoleLogs,
    // Tab management
    listTabs, selectTab, newTab, closeTab,
    // ULTRA
    extract, find, fillForm, action, waitFor, assert,
    // Recording & Replay
    recordStart, recordStop, recordList, replay,
    // Site knowledge
    learn, siteInfo,
    // Multi-browser
    listBrowsers, selectBrowser,
    // Multi-session coordination
    claimTab, releaseTab, sessions, handoff,
    // Shared state
    sharedGet, sharedSet, sharedDelete, sharedList,
    // Eval & Storage
    browserEval, browserStorage,
    // Network & Performance
    network, performance,
    // File & Clipboard
    upload, download, clipboard,
    // Annotated notes inbox
    notesList, notesGet, notesArchive, notesUnarchive, notesDelete,
    // Event-driven autonomous reactions
    browserOn, browserOff, browserEventsList, browserWaitForEvent,
    // Named mutexes for multi-agent coordination
    browserLock, browserUnlock, browserLocksList,
    // Diagnostics and support
    browserDiagnostics, browserSupportBundle,
  ];

  const server = new Server(
    { name: "MyBrowser MCP", version: "1.1.1" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: tools.map((t) => t.schema) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const tool = tools.find((t) => t.schema.name === toolName);
    if (!tool) {
      recordIssue({
        level: "warn",
        area: "tool_not_found",
        message: `Tool "${toolName}" not found`,
        toolName,
        sessionId,
      });
      return {
        content: [{ type: "text", text: `Tool "${toolName}" not found` }],
        isError: true,
      };
    }

    await stateManager.touchSession(sessionId);

    // Ownership check for mutating tools
    if (MUTATING_TOOLS.has(toolName) && await stateManager.shouldEnforceOwnership()) {
      const tabId = extractTabId(request.params.arguments);
        if (tabId === undefined) {
          recordIssue({
            level: "warn",
            area: "ownership",
            message: `${toolName} rejected because tabId is required while ownership is enforced`,
            toolName,
            sessionId,
          });
          return {
            content: [{
              type: "text",
            text: `tabId is required when tab ownership is enforced (multiple sessions active). Use list_tabs to find tab IDs.`,
          }],
          isError: true,
        };
      }

      try {
        const browserId = await getActiveBrowser();
        const tabKey = makeTabKey(browserId, tabId);
        if (!await stateManager.isTabAvailable(tabKey, sessionId)) {
          const owner = await stateManager.getTabOwner(tabKey);
          const ownerName = owner ? (await stateManager.getSessionName(owner) ?? owner) : "unknown";
          recordIssue({
            level: "warn",
            area: "ownership",
            message: `${toolName} rejected because tab ${tabId} on browser ${browserId} is owned by ${ownerName}`,
            toolName,
            sessionId,
            browserId,
          });
          return {
            content: [{
              type: "text",
              text: `Tab ${tabId} on browser ${browserId} is owned by session "${ownerName}". Claim it first with browser_claim_tab or ask the owner to release it.`,
            }],
            isError: true,
          };
        }
      } catch {
        // No browser connected — let the tool fail naturally
      }
    }

    try {
      return await tool.handle(context, request.params.arguments);
    } catch (error) {
      recordIssue({
        level: "error",
        area: "tool_failure",
        message: error instanceof Error ? error.message : String(error),
        toolName,
        sessionId,
        details: {
          arguments: request.params.arguments,
          stack: error instanceof Error ? error.stack : undefined,
        },
      });
      return {
        content: [{ type: "text", text: String(error) }],
        isError: true,
      };
    }
  });

  const originalClose = server.close.bind(server);
  server.close = async () => {
    // Each cleanup step is independent — catch per-step so a single
    // failure doesn't leak state elsewhere. Note:
    // clearEventHandlersForSession internally broadcasts a session-
    // scoped unregister to all connected browsers (via the broadcaster
    // installed in ws-server), so we don't need a separate push step.
    // In client mode the hub receives the RPC and does the broadcast
    // on its side; in hub mode it happens locally.
    for (const step of [
      () => stateManager.releaseAllTabs(sessionId),
      () => stateManager.releaseLocksForSession(sessionId),
      () => stateManager.clearEventHandlersForSession(sessionId),
      () => stateManager.removeSession(sessionId),
    ]) {
      try {
        await step();
      } catch (e) {
        console.error("Session cleanup step failed:", e);
      }
    }
    await originalClose();
    wss.close();
    await context.close();
  };

  return server;
}
