import { createHash } from "node:crypto";
import { ProtocolError, ProtocolErrorCode, Server, type CallToolResult, type Transport } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
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
import { click, type, hover, pressKey, drag, mouse, selectOption } from "./tools/input.js";

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
import { normalizeArguments } from "./tools/arg-aliases.js";
import { browserStorage } from "./tools/storage.js";

// ULTRA Phase 5: Network & Performance tools
import { network } from "./tools/network.js";
import { performance } from "./tools/performance.js";

// ULTRA: File & Clipboard tools
import { upload } from "./tools/upload.js";
import { download } from "./tools/download.js";
import { fetchFile } from "./tools/fetch-file.js";
import { check } from "./tools/check.js";
import { outline } from "./tools/outline.js";
import { triage } from "./tools/triage.js";
import { run } from "./tools/run.js";
import type { JevConfig } from "./jev/config.js";
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
  /** Stable key for this client's workspace; lets a restarted process resume its stopped session on the hub. */
  resumeKey?: string;
  telemetryConfig?: TelemetryConfig;
  telemetry?: TelemetryManager;
  requireHub?: boolean;
  clientOnly?: boolean;
  onHubUnavailable?: () => void;
  allowLocalExtensionWithoutToken?: boolean;
  localUrlHost?: string;
  /** Optional TypeSafe Jev decision layer (element-resolution fallback + browser_check). */
  jev?: JevConfig;
}

export let stateManager: IStateManager;

/**
 * Tools that mutate tab state. Subject to ownership checks.
 */
const MUTATING_TOOLS = new Set([
  "browser_navigate", "browser_go_back", "browser_go_forward",
  "browser_click", "browser_type", "browser_hover", "browser_press_key",
  "browser_drag", "browser_mouse", "browser_select_option",
  "select_tab", "close_tab",
  "browser_fill_form", "browser_action", "browser_triage", "browser_run",
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

/** The MCP side of MyBrowser: serves both protocol eras and routes calls to per-session runtimes. */
export interface MyBrowserMcpServer {
  /**
   * Serves MCP on `transport` (stdio when omitted). The opening message picks the
   * protocol era: `server/discover` or a 2026-07-28 envelope is modern, `initialize`
   * is legacy. Every connection shares the same browser sessions.
   */
  connect(transport?: Transport): Promise<void>;
  /** A new protocol instance for one connection (the factory given to serveStdio). */
  createServer(): Server;
  /** The MyBrowser session used for calls that carry no OpenCode session ID. */
  readonly sessionId: string;
  /** Live per-OpenCode-session runtimes (for diagnostics and tests). */
  sessionCount(): number;
  close(): Promise<void>;
}

export async function createServerWithTools(options: ServerOptions): Promise<MyBrowserMcpServer> {
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

/** OpenCode puts the calling session's ID here on every tools/call (documented request metadata). */
export const OPENCODE_SESSION_META = "ai.opencode/sessionID";
const OPENCODE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A session runtime without calls for this long is closed; its tabs stay parked on the hub for 2 h. */
export const SESSION_IDLE_MS = 60 * 60_000;
const SESSION_SWEEP_MS = 5 * 60_000;
/** Tools never change while the process runs (config changes restart it). */
const TOOLS_LIST_TTL_MS = 60 * 60_000;

/**
 * One MyBrowser session: its hub connection, Context (current tab, outline refs,
 * browser routing) and tool set. A process has a default one and, for MCP hosts
 * that name the calling session (OpenCode), one per calling session, so sessions
 * served by one shared process never see each other's tabs or state.
 */
interface SessionRuntime {
  readonly context: Context;
  readonly isHub: boolean;
  readonly tools: Tool[];
  readonly advertisedToolSchemas: Tool["schema"][];
  sessionId(): string;
  callTool(name: string, args: unknown): Promise<CallToolResult>;
  /** Synchronously refuses new work (pending hub calls fail with SERVER_SHUTTING_DOWN). */
  beginShutdown(): void;
  close(): Promise<void>;
  lastUsed: number;
  inFlight: number;
}

function resumeKeyFor(seed: string): string {
  return createHash("sha256").update(`mybrowser-resume\0${seed}`).digest("base64url").slice(0, 32);
}

async function createRuntime(options: ServerOptions, telemetry: TelemetryManager, exportState: boolean): Promise<SessionRuntime> {
  const { host, port, token } = options;
  const context = new Context(telemetry, options.localUrlHost);
  context.jev = options.jev;

  const incarnation = new SessionIncarnation(options.sessionId);
  let sessionId = incarnation.sessionId;
  context.sessionId = sessionId;

  const wss = await createWebSocketServer({
    host,
    port,
    token,
    context,
    requireHub: options.requireHub,
    clientOnly: options.clientOnly,
    onHubUnavailable: options.onHubUnavailable,
    allowLocalExtensionWithoutToken: options.allowLocalExtensionWithoutToken,
  });
  const sm = wss.stateManager;
  if (exportState) stateManager = sm;

  try {
    const registerSession = async (): Promise<void> => {
      const registration = await incarnation.register(sm, options.sessionName, options.resumeKey);
      sessionId = registration.sessionId;
      context.sessionId = registration.sessionId;
    };
    await registerSession();
    // Re-register session on hub reconnect (client mode only)
    wss.onReconnect?.(registerSession);
  } catch (error) {
    wss.beginShutdown();
    await Promise.allSettled([wss.close(), context.close()]);
    throw error;
  }

  // Helper to get the active browser for this session (for composite tab keys)
  const getActiveBrowser = async (): Promise<string> => {
    const resolution = await sm.resolveBrowserTarget(sessionId);
    if (!resolution.ok) throw new Error(resolution.message);
    // Remembered for the "Browser:" line in page results, so agents need not re-check.
    context.lastBrowser = { id: resolution.browserId, name: resolution.browserName };
    return resolution.browserId;
  };

  context.setTargetBrowserResolver(getActiveBrowser);
  // Tabs a session opens are its own; another session cannot drive them.
  context.claimTab = async (tabId: number) => {
    await sm.claimTab(sessionId, makeTabKey(await getActiveBrowser(), tabId));
  };

  // Create tool sets
  const { claimTab, releaseTab, sessions } = createSessionTools(sm, () => sessionId, getActiveBrowser);
  const { handoff, sharedGet, sharedSet, sharedDelete, sharedList } = createCollaborateTools(sm, () => sessionId, getActiveBrowser);
  const {
    listBrowsers,
    selectBrowser,
    useDefaultBrowser,
    setDefaultBrowser,
    getDefaultBrowser,
    clearDefaultBrowser,
  } = createBrowserTools(sm, () => sessionId);
  const { notesList, notesGet, notesArchive, notesUnarchive, notesDelete } = createNotesTools(sm);
  const { browserOn, browserOff, browserEventsList, browserWaitForEvent } = createEventsTools(sm, () => sessionId, getActiveBrowser);
  const { browserLock, browserUnlock, browserLocksList } = createLockTools(sm, () => sessionId);
  const { listTabs, selectTab, newTab, closeTab, keepTab, browserCleanup } = createTabTools({
    stateManager: sm,
    context,
    getSessionId: () => sessionId,
    getActiveBrowser,
  });
  const { recordStart, recordStop, recordList } = createRecordingTools(sm, () => sessionId);
  const { browserDiagnostics, browserSupportBundle } = createDiagnosticsTools({
    stateManager: sm,
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

  const allTools: Tool[] = [
    // Navigation (with auto-snapshot)
    navigate(true), goBack(true), goForward(true), wait,
    // Input
    click, type, hover, pressKey, drag, mouse, selectOption,
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
    upload, download, clipboard, fetchFile,
    // Annotated notes inbox
    notesList, notesGet, notesArchive, notesUnarchive, notesDelete,
    // Event-driven autonomous reactions
    browserOn, browserOff, browserEventsList, browserWaitForEvent,
    // Named mutexes for multi-agent coordination
    browserLock, browserUnlock, browserLocksList,
    // Diagnostics and support
    browserDiagnostics, browserSupportBundle,
    // Page map and Jev decision layer
    outline, triage, check, run,
  ];
  // browser_check is only listed when configured, so agents never see a tool that always fails;
  // browser_run additionally needs the autopilot flag. Telemetry coverage still checks every defined tool.
  const tools = allTools.filter((tool) => (tool !== check || context.jev) && (tool !== run || context.jev?.autopilot === true));
  const urlPolicy = context.localUrlHost
    ? `Canonical host for services on this MCP device: ${context.localUrlHost}. Do not use localhost, 127.0.0.1, or ::1; they are rewritten to this host.`
    : undefined;
  const advertisedToolSchemas = tools.map(({ schema }) => (
    urlPolicy && ["browser_navigate", "new_tab", "browser_action", "browser_download", "browser_fetch_file"].includes(schema.name)
      ? { ...schema, description: `${schema.description} ${urlPolicy}` }
      : schema
  ));
  if (exportState) {
    assertTelemetryPolicyCoverage(allTools.map((tool) => {
      const properties = tool.schema.inputSchema.properties;
      return {
        name: tool.schema.name,
        argumentFields: properties && typeof properties === "object" && !Array.isArray(properties)
          ? Object.keys(properties)
          : [],
      };
    }));
  }

  const callTool = async (requestedToolName: string, rawArguments: unknown): Promise<CallToolResult> => {
    const registeredTool = tools.find((candidate) => candidate.schema.name === requestedToolName);
    const toolName = registeredTool?.schema.name ?? "unknown_tool";
    let failureOutcome: RootToolOutcome | undefined;
    return telemetry.runToolCall({
      sessionId,
      toolName,
      arguments: rawArguments,
      unknownTool: registeredTool === undefined,
      classifyResult: (result) => {
        if (failureOutcome) return failureOutcome;
        return classifyToolResult(result);
      },
      classifyError: (error) => failureOutcome ?? classifyExplicitError(error),
    }, async () => {
      if (!registeredTool) {
        failureOutcome = { status: "error", errorCategory: "invalid_arguments" };
        recordIssue({
          level: "warn",
          area: "tool_not_found",
          message: `Tool "${requestedToolName}" not found`,
          toolName: requestedToolName,
          sessionId,
        });
        // An unknown tool is a protocol error (JSON-RPC Invalid params), not a tool result.
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${requestedToolName}`);
      }
      await sm.touchSession(sessionId);

      // Ownership: acting on a tab by id claims it for this session, unless another
      // session owns it. Calls without tabId run on the session's own tab, which
      // it got from new_tab, select_tab or an earlier tabId (all claimed), never
      // on the user's active tab.
      const ownedTabId = MUTATING_TOOLS.has(toolName) ? extractTabId(rawArguments) ?? extractTabId(normalizeArguments(toolName, rawArguments).args) : undefined;
      if (ownedTabId !== undefined) {
        const tabId = ownedTabId;
        try {
          const browserId = await getActiveBrowser();
          const tabKey = makeTabKey(browserId, tabId);
          const claim = await sm.claimTab(sessionId, tabKey);
          if (!claim.ok && claim.owner !== undefined) {
            failureOutcome = { status: "error", errorCategory: "ownership_denied" };
            const owner = claim.owner;
            const ownerName = await sm.getSessionName(owner) ?? owner;
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
                text: `Tab ${tabId} on browser ${browserId} is in use by another agent session ("${ownerName}"). Open your own tab with new_tab instead, or ask that session to release it.`,
              }],
              isError: true,
            };
          }
        } catch {
          // No browser connected — let the tool fail naturally
        }
      }

      // Common shapes from other browser tools ({ms}, {expression}, numeric refs...) are
      // rewritten to the canonical arguments, and the result says what was accepted.
      const { args: toolArgs, note: aliasNote } = normalizeArguments(toolName, rawArguments, context.lastRefPrefix);
      try {
        const result = await registeredTool.handle(context, toolArgs);
        if (!aliasNote) return result;
        return { ...result, content: [{ type: "text" as const, text: aliasNote }, ...(result.content ?? [])] };
      } catch (error) {
        failureOutcome = classifyExplicitError(error);
        recordIssue({
          level: "error",
          area: "tool_failure",
          message: error instanceof Error ? error.message : String(error),
          toolName,
          sessionId,
          details: {
            arguments: summarizeDiagnosticsArguments(toolName, rawArguments),
            stack: error instanceof Error ? error.stack : undefined,
          },
        });
        return {
          content: [{ type: "text", text: String(error) }],
          isError: true,
        };
      }
    }) as Promise<CallToolResult>;
  };

  let closePromise: Promise<void> | undefined;
  return {
    context,
    isHub: wss.isHub,
    tools,
    advertisedToolSchemas,
    sessionId: () => sessionId,
    callTool,
    lastUsed: Date.now(),
    inFlight: 0,
    beginShutdown: () => wss.beginShutdown(),
    close: () => {
      wss.beginShutdown();
      closePromise ??= (async () => {
        const results = await Promise.allSettled([wss.close()]);
        results.push(...await Promise.allSettled([context.close()]));
        const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
        if (errors.length > 0) throw new AggregateError(errors, "Session shutdown failed");
      })();
      return closePromise;
    },
  };
}

async function createServerWithTelemetry(options: ServerOptions, telemetry: TelemetryManager): Promise<MyBrowserMcpServer> {
  ensureDirectories();
  ensureNotesDirectories();

  // The default session: calls without an OpenCode session ID (other MCP hosts,
  // or OpenCode calls made outside a session), and the hub election for the process.
  const main = await createRuntime(options, telemetry, true);
  const tools = main.tools;
  const advertisedToolSchemas = main.advertisedToolSchemas;
  let toolsSchemaDigest: string | undefined;
  if (telemetry.enabled) {
    try {
      toolsSchemaDigest = schemaDigest(tools);
    } catch {
      // Telemetry digest construction must not affect server startup.
    }
  }

  // One runtime per calling OpenCode session. A shared (pooled) process serves
  // every session and project folder on the machine; each gets its own hub
  // session, so tabs, current tab, outline refs and browser choice never mix.
  const sessions = new Map<string, Promise<SessionRuntime>>();
  let closing = false;
  const runtimeFor = async (meta: Record<string, unknown> | undefined): Promise<SessionRuntime> => {
    const raw = meta?.[OPENCODE_SESSION_META];
    if (typeof raw !== "string" || !OPENCODE_SESSION_ID.test(raw) || options.requireHub) return main;
    if (closing) throw new Error("SERVER_SHUTTING_DOWN");
    let pending = sessions.get(raw);
    if (!pending) {
      pending = createRuntime({
        ...options,
        sessionId: undefined,
        sessionName: `${options.sessionName ? `${options.sessionName} ` : ""}OpenCode ${raw.slice(-8)}`,
        // The next process (after an MCP restart) resumes this OpenCode session's tabs.
        resumeKey: resumeKeyFor(`opencode-session\0${raw}`),
        // The default runtime already owns or found the hub; sessions only join it.
        clientOnly: true,
        requireHub: false,
      }, telemetry, false);
      sessions.set(raw, pending);
      pending.catch(() => {
        if (sessions.get(raw) === pending) sessions.delete(raw);
      });
    }
    return pending;
  };

  // Idle sessions are closed (parked on the hub, so a later call resumes their tabs).
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, pending] of sessions) {
      void pending.then((runtime) => {
        if (runtime.inFlight > 0 || now - runtime.lastUsed < SESSION_IDLE_MS || sessions.get(key) !== pending) return;
        sessions.delete(key);
        void runtime.close().catch(() => console.error("[MyBrowser MCP] SESSION_CLOSE_FAILED"));
      }, () => undefined);
    }
  }, SESSION_SWEEP_MS);
  sweep.unref();

  const createServer = (): Server => {
    const server = new Server(
      { name: "MyBrowser MCP", version: VERSION },
      {
        capabilities: { tools: {} },
        cacheHints: { "tools/list": { ttlMs: TOOLS_LIST_TTL_MS, cacheScope: "private" } },
      },
    );

    server.setRequestHandler("tools/list", async (_request, ctx) => {
      if (telemetry.enabled && toolsSchemaDigest) {
        try {
          // 2026-07-28 requests carry client info per request; legacy ones sent it in initialize.
          const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
          const client = (envelope?.["io.modelcontextprotocol/clientInfo"] as { name?: string; version?: string } | undefined) ?? server.getClientVersion();
          const capabilities = (envelope?.["io.modelcontextprotocol/clientCapabilities"] as Record<string, unknown> | undefined) ?? server.getClientCapabilities();
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
      return { tools: advertisedToolSchemas as never };
    });

    server.setRequestHandler("tools/call", async (request, ctx) => {
      const meta = (ctx.mcpReq._meta ?? request.params._meta) as Record<string, unknown> | undefined;
      const runtime = await runtimeFor(meta);
      runtime.inFlight += 1;
      try {
        return await runtime.callTool(request.params.name, request.params.arguments);
      } finally {
        runtime.inFlight -= 1;
        runtime.lastUsed = Date.now();
      }
    });
    return server;
  };

  const handles: StdioServerHandle[] = [];
  let closePromise: Promise<void> | undefined;
  return {
    createServer,
    get sessionId() {
      return main.sessionId();
    },
    sessionCount: () => sessions.size,
    connect: async (transport?: Transport) => {
      handles.push(serveStdio(createServer, {
        ...(transport ? { transport } : {}),
        onerror: (error) => console.error(`[MyBrowser MCP] MCP transport error: ${error.message}`),
      }));
    },
    close: () => {
      closing = true;
      clearInterval(sweep);
      // New work is refused at once; the default session stays able to host the
      // hub until the per-session clients have parked.
      main.beginShutdown();
      closePromise ??= (async () => {
        const errors: unknown[] = [];
        try {
          const settled = await Promise.allSettled(handles.map((handle) => handle.close()));
          errors.push(...settled.flatMap((r) => (r.status === "rejected" ? [r.reason] : [])));
          // Session runtimes first (they are hub clients). Parking them is best effort:
          // when this process is the hub, it is going away with them.
          const sessionClosed = await Promise.allSettled([...sessions.values()].map(async (pending) => (await pending).close()));
          if (sessionClosed.some((r) => r.status === "rejected")) console.error("[MyBrowser MCP] SESSION_CLOSE_FAILED");
          sessions.clear();
          try {
            await main.close();
          } catch (error) {
            errors.push(error);
          }
          if (errors.length > 0) throw new AggregateError(errors, "Server shutdown failed");
        } finally {
          await telemetry.close(2_000);
        }
      })();
      return closePromise;
    },
  };
}
