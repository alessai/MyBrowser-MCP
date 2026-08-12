import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Context } from "./context.js";
import { VERSION } from "./version.js";
import { createWebSocketServer } from "./ws-server.js";
import { makeTabKey, type IStateManager } from "./state-manager.js";
import type { Tool } from "./tools/types.js";
import { recordIssue } from "./logger.js";
import { SessionIncarnation } from "./session-incarnation.js";
import { assertTelemetryPolicyCoverage } from "./telemetry/policies.js";
import { summarizeDiagnosticsArguments } from "./telemetry/sanitize.js";
import { TelemetryManager, type RootToolOutcome } from "./telemetry/manager.js";
import type { TelemetryConfig, TelemetryErrorCategory } from "./telemetry/types.js";

// Navigation tools
import { navigate, goBack, goForward, wait } from "./tools/navigation.js";

// Input tools
import { click, type, hover, pressKey, drag, selectOption } from "./tools/input.js";

// Snapshot tools
import { snapshot } from "./tools/snapshot.js";

// Media tools
import { screenshot, getConsoleLogs } from "./tools/media.js";

// Viewport / device emulation tools
import { setViewport, resetViewport, viewportInfo } from "./tools/viewport.js";

// Tab tools
import { createTabTools } from "./tools/tabs.js";

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
import { createRecordingTools } from "./tools/record.js";

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
  telemetryConfig?: TelemetryConfig;
  telemetry?: TelemetryManager;
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
  "browser_record_start", "browser_replay",
  "browser_eval", "browser_storage", "browser_upload", "browser_clipboard",
  "browser_set_viewport", "browser_reset_viewport",
]);

function extractTabId(args: unknown): number | undefined {
  if (args && typeof args === "object" && "tabId" in args) {
    const val = (args as Record<string, unknown>).tabId;
    if (typeof val === "number") return val;
  }
  return undefined;
}

export async function createServerWithTools(options: ServerOptions) {
  const telemetry = options.telemetry ?? (options.telemetryConfig
    ? TelemetryManager.create(options.telemetryConfig, {
      onDiagnostic: (diagnostic) => recordIssue({
        level: "error",
        area: "telemetry_writer",
        message: `Internal telemetry writer disabled (${diagnostic.reason})`,
      }),
    })
    : TelemetryManager.disabled());
  try {
    return await createServerWithTelemetry(options, telemetry);
  } catch (error) {
    await telemetry.close(2_000);
    throw error;
  }
}

function classifyToolResult(result: unknown): RootToolOutcome {
  if (typeof result !== "object" || result === null) {
    return { status: "error", errorCategory: "unknown" };
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(result, "isError");
    if (!descriptor) return { status: "success" };
    if (!("value" in descriptor)) return { status: "error", errorCategory: "unknown" };
    if (descriptor.value === true) return { status: "error", errorCategory: "unknown" };
    if (descriptor.value === false || descriptor.value === undefined) return { status: "success" };
    return { status: "error", errorCategory: "unknown" };
  } catch {
    return { status: "error", errorCategory: "unknown" };
  }
}

const EXPLICIT_ERROR_CATEGORIES: Readonly<Record<string, TelemetryErrorCategory>> = Object.freeze({
  INVALID_ARGUMENTS: "invalid_arguments",
  AUTHORIZATION_DENIED: "authorization_denied",
  OWNERSHIP_DENIED: "ownership_denied",
  NOT_CONNECTED: "not_connected",
  BROWSER_NOT_FOUND: "browser_not_found",
  TAB_NOT_FOUND: "tab_not_found",
  ELEMENT_NOT_FOUND: "element_not_found",
  TIMEOUT: "timeout",
  REQUEST_EXPIRED: "request_expired",
  QUEUE_OVERLOADED: "queue_overloaded",
  SESSION_CLOSED: "session_closed",
  EXTENSION_WORKER_RESTARTED: "worker_restarted",
  PROTOCOL_ERROR: "protocol_error",
  STORAGE_FAILURE: "storage_failure",
});

function classifyExplicitError(error: unknown): RootToolOutcome {
  if (typeof error !== "object" || error === null) {
    return { status: "error", errorCategory: "unknown" };
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(error, "code");
  } catch {
    return { status: "error", errorCategory: "unknown" };
  }
  const code = descriptor && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
  const errorCategory = code ? EXPLICIT_ERROR_CATEGORIES[code] : undefined;
  if (!errorCategory) return { status: "error", errorCategory: "unknown" };
  if (errorCategory === "timeout" || errorCategory === "request_expired") {
    return { status: "timeout", errorCategory };
  }
  if (errorCategory === "worker_restarted" || errorCategory === "session_closed") {
    return { status: "cancelled", errorCategory };
  }
  return { status: "error", errorCategory };
}

function schemaDigest(tools: readonly Tool[]): string {
  return createHash("sha256")
    .update(JSON.stringify(tools.map((tool) => ({
      name: tool.schema.name,
      inputSchema: tool.schema.inputSchema,
    }))))
    .digest("base64url");
}

async function createServerWithTelemetry(options: ServerOptions, telemetry: TelemetryManager) {
  const { host, port, token } = options;
  const context = new Context(telemetry);

  const incarnation = new SessionIncarnation(options.sessionId);
  let sessionId = incarnation.sessionId;
  context.sessionId = sessionId;

  ensureDirectories();
  ensureNotesDirectories();

  const wss = await createWebSocketServer({ host, port, token, context });
  stateManager = wss.stateManager;

  const registerSession = async (): Promise<void> => {
    const registration = await incarnation.register(stateManager, options.sessionName);
    sessionId = registration.sessionId;
    context.sessionId = registration.sessionId;
  };
  await registerSession();

  // Re-register session on hub reconnect (client mode only)
  wss.onReconnect?.(registerSession);

  // Helper to get the active browser for this session (for composite tab keys)
  const getActiveBrowser = async (): Promise<string> => {
    const resolution = await stateManager.resolveBrowserTarget(sessionId);
    if (!resolution.ok) throw new Error(resolution.message);
    return resolution.browserId;
  };

  context.setTargetBrowserResolver(getActiveBrowser);

  // Create tool sets
  const { claimTab, releaseTab, sessions } = createSessionTools(stateManager, () => sessionId, getActiveBrowser);
  const { handoff, sharedGet, sharedSet, sharedDelete, sharedList } = createCollaborateTools(stateManager, () => sessionId, getActiveBrowser);
  const {
    listBrowsers,
    selectBrowser,
    useDefaultBrowser,
    setDefaultBrowser,
    getDefaultBrowser,
    clearDefaultBrowser,
  } = createBrowserTools(stateManager, () => sessionId);
  const { notesList, notesGet, notesArchive, notesUnarchive, notesDelete } = createNotesTools(stateManager);
  const { browserOn, browserOff, browserEventsList, browserWaitForEvent } = createEventsTools(stateManager, () => sessionId, getActiveBrowser);
  const { browserLock, browserUnlock, browserLocksList } = createLockTools(stateManager, () => sessionId);
  const { listTabs, selectTab, newTab, closeTab, keepTab, browserCleanup } = createTabTools({
    stateManager,
    context,
    getSessionId: () => sessionId,
    getActiveBrowser,
  });
  const { recordStart, recordStop, recordList } = createRecordingTools(
    stateManager,
    () => sessionId,
  );
  const { browserDiagnostics, browserSupportBundle } = createDiagnosticsTools({
    stateManager,
    context,
    getActiveBrowser,
    serverInfo: {
      version: VERSION,
      host,
      port,
      getSessionId: () => sessionId,
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
    // Viewport / device emulation
    setViewport, resetViewport, viewportInfo,
    // Tab management
    listTabs, selectTab, newTab, closeTab, keepTab, browserCleanup,
    // ULTRA
    extract, find, fillForm, action, waitFor, assert,
    // Recording & Replay
    recordStart, recordStop, recordList, replay,
    // Site knowledge
    learn, siteInfo,
    // Multi-browser
    listBrowsers, selectBrowser, useDefaultBrowser, setDefaultBrowser, getDefaultBrowser, clearDefaultBrowser,
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
  assertTelemetryPolicyCoverage(tools.map((tool) => {
    const properties = tool.schema.inputSchema.properties;
    return {
      name: tool.schema.name,
      argumentFields: properties && typeof properties === "object" && !Array.isArray(properties)
        ? Object.keys(properties)
        : [],
    };
  }));

  const server = new Server(
    { name: "MyBrowser MCP", version: VERSION },
    { capabilities: { tools: {} } }
  );
  let toolsSchemaDigest: string | undefined;
  if (telemetry.enabled) {
    try {
      toolsSchemaDigest = schemaDigest(tools);
    } catch {
      // Telemetry digest construction must not affect server startup.
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (telemetry.enabled && toolsSchemaDigest) {
      try {
        const client = server.getClientVersion();
        const capabilities = server.getClientCapabilities();
        telemetry.recordToolsListed({
          ...(client?.name ? { clientName: client.name } : {}),
          ...(client?.version ? { clientVersion: client.version } : {}),
          clientSupportsSampling: capabilities?.sampling !== undefined,
          clientSupportsRoots: capabilities?.roots !== undefined,
          clientSupportsElicitation: capabilities?.elicitation !== undefined,
          toolCount: tools.length,
          schemaDigest: toolsSchemaDigest,
        });
      } catch {
        // Telemetry event construction must not affect the list-tools response.
      }
    }
    return { tools: tools.map((t) => t.schema) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const requestedToolName = request.params.name;
    const registeredTool = tools.find((candidate) => candidate.schema.name === requestedToolName);
    const toolName = registeredTool?.schema.name ?? "unknown_tool";
    let failureOutcome: RootToolOutcome | undefined;
    return telemetry.runToolCall({
      sessionId,
      toolName,
      arguments: request.params.arguments,
      unknownTool: registeredTool === undefined,
      classifyResult: (result) => {
        if (failureOutcome) return failureOutcome;
        return classifyToolResult(result);
      },
      classifyError: classifyExplicitError,
    }, async () => {
      const tool = registeredTool;
      if (!tool) {
        failureOutcome = { status: "error", errorCategory: "invalid_arguments" };
        recordIssue({
          level: "warn",
          area: "tool_not_found",
          message: `Tool "${requestedToolName}" not found`,
          toolName: requestedToolName,
          sessionId,
        });
        return {
          content: [{ type: "text", text: `Tool "${requestedToolName}" not found` }],
          isError: true,
        };
      }

      await stateManager.touchSession(sessionId);

      // Ownership check for mutating tools
      if (MUTATING_TOOLS.has(toolName) && await stateManager.shouldEnforceOwnership()) {
        const tabId = extractTabId(request.params.arguments);
        if (tabId === undefined) {
          failureOutcome = { status: "error", errorCategory: "ownership_denied" };
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
            failureOutcome = { status: "error", errorCategory: "ownership_denied" };
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
        failureOutcome = classifyExplicitError(error);
        recordIssue({
          level: "error",
          area: "tool_failure",
          message: error instanceof Error ? error.message : String(error),
          toolName,
          sessionId,
          details: {
            arguments: summarizeDiagnosticsArguments(toolName, request.params.arguments),
            stack: error instanceof Error ? error.stack : undefined,
          },
        });
        return {
          content: [{ type: "text", text: String(error) }],
          isError: true,
        };
      }
    });
  });

  const originalClose = server.close.bind(server);
  let closePromise: Promise<void> | undefined;
  server.close = () => {
    wss.beginShutdown();
    if (closePromise) return closePromise;
    closePromise = (async () => {
      const errors: unknown[] = [];
      try {
        for (const step of [
          () => originalClose(),
          () => wss.close(),
          () => context.close(),
        ]) {
          try {
            await step();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, "Server shutdown failed");
        }
      } finally {
        await telemetry.close(2_000);
      }
    })();
    return closePromise;
  };

  return server;
}
