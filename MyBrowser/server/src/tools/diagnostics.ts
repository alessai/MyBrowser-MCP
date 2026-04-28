import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Context } from "../context.js";
import type { IStateManager } from "../state-manager.js";
import { CONFIG_FILE } from "../auth.js";
import {
  ERROR_LOG_FILE,
  LOG_DIR,
  LOG_FILE,
  getLastToolFailure,
  getRecentIssues,
  readLogTail,
  sanitizeForDiagnostics,
  writeSupportBundle,
} from "../logger.js";
import type { Tool } from "./types.js";

const DiagnosticsArgs = z.object({
  includeLogs: z.boolean().optional().default(false)
    .describe("Include recent server log tails in the response. Defaults to false."),
  includeExtension: z.boolean().optional().default(true)
    .describe("Ask the connected browser extension for its diagnostics. Defaults to true."),
});

const SupportBundleArgs = z.object({
  includeExtension: z.boolean().optional().default(true)
    .describe("Ask the connected browser extension for its diagnostics. Defaults to true."),
});

interface DiagnosticsFactoryOptions {
  stateManager: IStateManager;
  context: Context;
  getActiveBrowser: () => Promise<string>;
  serverInfo: {
    version: string;
    host: string;
    port: number;
    sessionId: string;
    sessionName?: string;
    isHub: boolean;
  };
}

async function collectDiagnostics(
  options: DiagnosticsFactoryOptions,
  args: z.infer<typeof DiagnosticsArgs>,
): Promise<Record<string, unknown>> {
  const { stateManager, context, getActiveBrowser, serverInfo } = options;

  const [browsers, sessions, locks] = await Promise.all([
    stateManager.listBrowsers().catch((error) => ({ error: String(error) })),
    stateManager.listSessions().catch((error) => ({ error: String(error) })),
    stateManager.listLocks().catch((error) => ({ error: String(error) })),
  ]);

  let selectedBrowser: unknown = null;
  try {
    const browserId = await getActiveBrowser();
    selectedBrowser = {
      browserId,
      sessionSelectedBrowser: await stateManager.getSessionBrowser(serverInfo.sessionId),
      contextActiveBrowserId: context.activeBrowserId,
    };
  } catch (error) {
    selectedBrowser = { error: error instanceof Error ? error.message : String(error) };
  }

  let extensionDiagnostics: unknown = null;
  if (args.includeExtension) {
    try {
      extensionDiagnostics = await context.sendSocketMessage(
        "browser_diagnostics",
        {},
        { timeoutMs: 5_000 },
      );
    } catch (error) {
      extensionDiagnostics = { error: error instanceof Error ? error.message : String(error) };
    }
  }

  const diagnostics: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    server: {
      name: "MyBrowser MCP",
      version: serverInfo.version,
      mode: serverInfo.isHub ? "hub" : "client",
      host: serverInfo.host,
      port: serverInfo.port,
      sessionId: serverInfo.sessionId,
      sessionName: serverInfo.sessionName,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
    },
    paths: {
      configFile: CONFIG_FILE,
      logDir: LOG_DIR,
      logFile: LOG_FILE,
      errorLogFile: ERROR_LOG_FILE,
    },
    browserState: {
      connectedBrowsers: browsers,
      selectedBrowser,
    },
    sessions,
    locks,
    recentIssues: getRecentIssues(50),
    lastToolFailure: getLastToolFailure(),
    extensionDiagnostics,
  };

  if (args.includeLogs) {
    diagnostics.logs = {
      serverLogTail: readLogTail(LOG_FILE),
      errorLogTail: readLogTail(ERROR_LOG_FILE),
    };
  }

  return sanitizeForDiagnostics(diagnostics) as Record<string, unknown>;
}

export function createDiagnosticsTools(options: DiagnosticsFactoryOptions): {
  browserDiagnostics: Tool;
  browserSupportBundle: Tool;
} {
  const browserDiagnostics: Tool = {
    schema: {
      name: "browser_diagnostics",
      description:
        "Collect MyBrowser MCP diagnostics with redacted sensitive values: server version, connected browsers, sessions, selected browser, recent failures, extension status, and optional recent log tails.",
      inputSchema: zodToJsonSchema(DiagnosticsArgs),
    },
    handle: async (_context, params) => {
      const args = DiagnosticsArgs.parse(params ?? {});
      const diagnostics = await collectDiagnostics(options, args);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(diagnostics, null, 2) },
        ],
      };
    },
  };

  const browserSupportBundle: Tool = {
    schema: {
      name: "browser_support_bundle",
      description:
        "Write a redacted support bundle JSON file under ~/.mybrowser/support-bundles containing diagnostics and recent server log tails.",
      inputSchema: zodToJsonSchema(SupportBundleArgs),
    },
    handle: async (_context, params) => {
      const supportArgs = SupportBundleArgs.parse(params ?? {});
      const diagnostics = await collectDiagnostics(options, {
        includeLogs: true,
        includeExtension: supportArgs.includeExtension,
      });
      const path = writeSupportBundle(diagnostics);
      return {
        content: [
          {
            type: "text" as const,
            text: `Support bundle written to ${path}\n\n${JSON.stringify({ path, generatedAt: diagnostics.generatedAt }, null, 2)}`,
          },
        ],
      };
    },
  };

  return { browserDiagnostics, browserSupportBundle };
}
