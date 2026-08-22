#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { program } from "commander";
import { fileURLToPath } from "node:url";
import { loadOrCreateConfig, validateConfigOverrides } from "./auth.js";
import {
  assertLoopbackHubHost,
  createDetachedHubEnsurer,
  HUB_AUTOSTART_TOKEN_ENV,
  isLoopbackHost,
} from "./hub-autostart.js";
import { createServerWithTools } from "./server.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { initializePersistentLogging } from "./logger.js";
import { type TelemetryCliOptions, resolveProcessTelemetryConfig } from "./telemetry/config.js";
import { registerTraceCommands } from "./telemetry/commands.js";
import { formatStartupFailure } from "./telemetry/startup-error.js";
import { VERSION } from "./version.js";

initializePersistentLogging();

function setupExitWatchdog(server: Server) {
  process.stdin.on("close", async () => {
    setTimeout(() => process.exit(0), 15_000);
    await server.close();
    process.exit(0);
  });

  process.stdin.on("end", async () => {
    setTimeout(() => process.exit(0), 15_000);
    await server.close();
    process.exit(0);
  });
}

interface CliOptions extends TelemetryCliOptions {
  host?: string;
  port?: number;
  token?: string;
  session?: string;
  hub?: boolean;
  ensureHub?: boolean;
}

program
  .name("mybrowser-mcp")
  .version(VERSION)
  .option("--host <host>", "Host to bind WebSocket server to")
  .option("--port <port>", "Port for WebSocket server", parseInt)
  .option("--token <token>", "Shared secret for authentication")
  .option("--session <name>", "Human-readable session name for multi-agent coordination")
  .option("--hub", "Run as standalone hub server (no MCP stdio transport)")
  .option("--ensure-hub", "Use a detached local hub that survives the MCP client process")
  .option("--trace-internal", "Record private local AI-tool telemetry")
  .option("--trace-dir <path>", "Private local telemetry directory")
  .option("--trace-retention-days <days>", "Telemetry retention in days", Number)
  .option("--trace-max-mb <megabytes>", "Maximum aggregate telemetry size", Number)
  .action(async (opts: CliOptions) => {
    if (opts.hub && opts.ensureHub) {
      throw new Error("--hub and --ensure-hub cannot be used together");
    }
    validateConfigOverrides(opts);
    if (opts.ensureHub && opts.host !== undefined) assertLoopbackHubHost(opts.host);
    const config = loadOrCreateConfig({
      host: opts.host,
      port: opts.port,
      token: opts.token ?? (opts.hub ? process.env[HUB_AUTOSTART_TOKEN_ENV] : undefined),
    });
    const telemetryConfig = resolveProcessTelemetryConfig(opts, opts.hub === true);
    const localExtensionAuth = (
      !opts.hub
      && !opts.ensureHub
      && opts.token === undefined
      && isLoopbackHost(config.host)
    );

    console.error(`[MyBrowser MCP] WebSocket server: ws://${config.host}:${config.port}`);
    const tokenSource = opts.token ? "provided by --token" : "see ~/.mybrowser/config.json";
    console.error(`[MyBrowser MCP] Auth token: [redacted] (${tokenSource})`);
    if (localExtensionAuth) {
      console.error("[MyBrowser MCP] Local extension auth: automatic");
    }
    if (opts.session) {
      console.error(`[MyBrowser MCP] Session name: ${opts.session}`);
    }

    const ensureHub = opts.ensureHub
      ? createDetachedHubEnsurer({
        ...config,
        entrypoint: fileURLToPath(import.meta.url),
      })
      : undefined;
    await ensureHub?.();
    const server = await createServerWithTools({
      host: config.host,
      port: config.port,
      token: config.token,
      sessionName: opts.session,
      telemetryConfig,
      requireHub: opts.hub === true,
      clientOnly: opts.ensureHub === true,
      allowLocalExtensionWithoutToken: localExtensionAuth,
      onHubUnavailable: ensureHub
        ? () => {
          void ensureHub().catch(() => console.error("[MyBrowser MCP] HUB_RECOVERY_FAILED"));
        }
        : undefined,
    });

    if (opts.hub) {
      // Standalone hub mode — just keep the process alive via WS server
      console.error(`[MyBrowser MCP] Running in standalone hub mode`);
      // Keep process alive — the WS server handles everything
      process.on("SIGINT", async () => {
        await server.close();
        process.exit(0);
      });
      process.on("SIGTERM", async () => {
        await server.close();
        process.exit(0);
      });
    } else {
      // MCP stdio mode — connect transport and watch for parent exit
      setupExitWatchdog(server);
      const transport = new StdioServerTransport();
      await server.connect(transport);
    }
  });

registerTraceCommands(program);

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(`[MyBrowser MCP] Startup failed: ${formatStartupFailure(error)}`);
  process.exitCode = 1;
}
