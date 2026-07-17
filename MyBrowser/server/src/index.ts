#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { program } from "commander";
import { loadOrCreateConfig } from "./auth.js";
import { createServerWithTools } from "./server.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { initializePersistentLogging } from "./logger.js";
import { type TelemetryCliOptions, resolveProcessTelemetryConfig } from "./telemetry/config.js";
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
}

program
  .name("mybrowser-mcp")
  .version(VERSION)
  .option("--host <host>", "Host to bind WebSocket server to")
  .option("--port <port>", "Port for WebSocket server", parseInt)
  .option("--token <token>", "Shared secret for authentication")
  .option("--session <name>", "Human-readable session name for multi-agent coordination")
  .option("--hub", "Run as standalone hub server (no MCP stdio transport)")
  .option("--trace-internal", "Record private local AI-tool telemetry")
  .option("--trace-dir <path>", "Private local telemetry directory")
  .option("--trace-retention-days <days>", "Telemetry retention in days", Number)
  .option("--trace-max-mb <megabytes>", "Maximum aggregate telemetry size", Number)
  .action(async (opts: CliOptions) => {
    const config = loadOrCreateConfig({
      host: opts.host,
      port: opts.port,
      token: opts.token,
    });
    const telemetryConfig = resolveProcessTelemetryConfig(opts, opts.hub === true);

    console.error(`[MyBrowser MCP] WebSocket server: ws://${config.host}:${config.port}`);
    console.error(`[MyBrowser MCP] Auth token: [redacted] (see ~/.mybrowser/config.json)`);
    if (opts.session) {
      console.error(`[MyBrowser MCP] Session name: ${opts.session}`);
    }

    const server = await createServerWithTools({
      host: config.host,
      port: config.port,
      token: config.token,
      sessionName: opts.session,
      telemetryConfig,
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

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(`[MyBrowser MCP] Startup failed: ${formatStartupFailure(error)}`);
  process.exitCode = 1;
}
