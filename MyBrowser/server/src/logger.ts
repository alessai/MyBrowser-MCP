import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LogLevel = "info" | "warn" | "error";

export interface IssueEvent {
  timestamp: string;
  level: LogLevel;
  area: string;
  message: string;
  toolName?: string;
  sessionId?: string;
  browserId?: string;
  details?: unknown;
}

const MYBROWSER_DIR = join(homedir(), ".mybrowser");
export const LOG_DIR = join(MYBROWSER_DIR, "logs");
export const LOG_FILE = join(LOG_DIR, "mybrowser-mcp.log");
export const ERROR_LOG_FILE = join(LOG_DIR, "mybrowser-mcp-errors.log");
export const SUPPORT_BUNDLE_DIR = join(MYBROWSER_DIR, "support-bundles");

const MAX_RECENT_ISSUES = 100;
const recentIssues: IssueEvent[] = [];

let initialized = false;
let originalConsole: Pick<Console, "error" | "warn" | "info" | "log"> | null = null;

function ensureLogDirectories(): void {
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(SUPPORT_BUNDLE_DIR, { recursive: true });
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ""}`;
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function redactSensitive(input: string): string {
  return input
    .replace(/("?(?:authToken|token|authorization|password|secret)"?\s*[:=]\s*")([^"\n]+)(")/gi, "$1[redacted]$3")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\-/]+=*/gi, "$1[redacted]")
    .replace(/([?&](?:token|authToken|password|secret)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b[a-f0-9]{64}\b/gi, "[redacted-token]");
}

function formatArgs(args: unknown[]): string {
  return redactSensitive(args.map(safeStringify).join(" "));
}

function appendLog(level: LogLevel, message: string): void {
  try {
    ensureLogDirectories();
    const entry = JSON.stringify({ timestamp: new Date().toISOString(), level, message }) + "\n";
    appendFileSync(LOG_FILE, entry, "utf8");
    if (level === "error") {
      appendFileSync(ERROR_LOG_FILE, entry, "utf8");
    }
  } catch {
    // Logging must never crash the MCP server.
  }
}

export function initializePersistentLogging(): void {
  if (initialized) return;
  initialized = true;
  ensureLogDirectories();
  originalConsole = {
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    info: console.info.bind(console),
    log: console.log.bind(console),
  };

  console.error = (...args: unknown[]) => {
    appendLog("error", formatArgs(args));
    originalConsole?.error(...args);
  };
  console.warn = (...args: unknown[]) => {
    appendLog("warn", formatArgs(args));
    originalConsole?.warn(...args);
  };
  console.info = (...args: unknown[]) => {
    appendLog("info", formatArgs(args));
    originalConsole?.info(...args);
  };
  console.log = (...args: unknown[]) => {
    appendLog("info", formatArgs(args));
    originalConsole?.log(...args);
  };

  appendLog("info", "MyBrowser MCP logging initialized");
}

export function recordIssue(issue: Omit<IssueEvent, "timestamp">): IssueEvent {
  const fullIssue: IssueEvent = {
    timestamp: new Date().toISOString(),
    ...issue,
    message: redactSensitive(issue.message),
    details: sanitizeForDiagnostics(issue.details),
  };
  recentIssues.push(fullIssue);
  while (recentIssues.length > MAX_RECENT_ISSUES) recentIssues.shift();
  appendLog(fullIssue.level, `[${fullIssue.area}] ${fullIssue.message}`);
  return fullIssue;
}

export function getRecentIssues(limit = 50): IssueEvent[] {
  return recentIssues.slice(-limit);
}

export function getLastToolFailure(): IssueEvent | null {
  for (let i = recentIssues.length - 1; i >= 0; i--) {
    const issue = recentIssues[i]!;
    if (issue.area === "tool_failure") return issue;
  }
  return null;
}

export function sanitizeForDiagnostics(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return redactSensitive(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSensitive(value.message),
      stack: value.stack ? redactSensitive(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) return value.map(sanitizeForDiagnostics);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (/token|auth|password|secret/i.test(key)) {
        out[key] = "[redacted]";
      } else {
        out[key] = sanitizeForDiagnostics(val);
      }
    }
    return out;
  }
  return String(value);
}

export function readLogTail(filePath: string, maxBytes = 64 * 1024): string {
  try {
    const raw = readFileSync(filePath);
    const slice = raw.length > maxBytes ? raw.subarray(raw.length - maxBytes) : raw;
    return redactSensitive(slice.toString("utf8"));
  } catch {
    return "";
  }
}

export function writeSupportBundle(data: unknown): string {
  ensureLogDirectories();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(SUPPORT_BUNDLE_DIR, `mybrowser-diagnostics-${stamp}.json`);
  writeFileSync(path, JSON.stringify(sanitizeForDiagnostics(data), null, 2) + "\n", "utf8");
  return path;
}
