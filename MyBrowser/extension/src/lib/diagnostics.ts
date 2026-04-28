export type ExtensionLogLevel = 'info' | 'warn' | 'error';

export interface ExtensionIssue {
  timestamp: string;
  level: ExtensionLogLevel;
  area: string;
  message: string;
  details?: unknown;
}

const MAX_RECENT_ISSUES = 100;
const recentIssues: ExtensionIssue[] = [];

function redactSensitive(input: string): string {
  return input
    .replace(/("?(?:authToken|token|authorization|password|secret)"?\s*[:=]\s*")([^"\n]+)(")/gi, '$1[redacted]$3')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\-/]+=*/gi, '$1[redacted]')
    .replace(/([?&](?:token|authToken|password|secret)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b[a-f0-9]{64}\b/gi, '[redacted-token]');
}

export function sanitizeForDiagnostics(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return redactSensitive(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSensitive(value.message),
      stack: value.stack ? redactSensitive(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) return value.map(sanitizeForDiagnostics);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (/token|auth|password|secret/i.test(key)) {
        out[key] = '[redacted]';
      } else {
        out[key] = sanitizeForDiagnostics(val);
      }
    }
    return out;
  }
  return String(value);
}

export function recordExtensionIssue(
  area: string,
  message: string,
  details?: unknown,
  level: ExtensionLogLevel = 'error',
): ExtensionIssue {
  const issue: ExtensionIssue = {
    timestamp: new Date().toISOString(),
    level,
    area,
    message: redactSensitive(message),
    details: sanitizeForDiagnostics(details),
  };
  recentIssues.push(issue);
  while (recentIssues.length > MAX_RECENT_ISSUES) recentIssues.shift();
  return issue;
}

export function getRecentExtensionIssues(limit = 50): ExtensionIssue[] {
  return recentIssues.slice(-limit);
}

export function getExtensionDiagnostics(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return sanitizeForDiagnostics({
    generatedAt: new Date().toISOString(),
    extension: {
      id: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
      manifestVersion: chrome.runtime.getManifest().manifest_version,
    },
    recentIssues: getRecentExtensionIssues(50),
    ...extra,
  }) as Record<string, unknown>;
}
