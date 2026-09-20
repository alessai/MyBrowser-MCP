const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const INVALID_TARGET_HOSTS = new Set([...LOOPBACK_HOSTS, "0.0.0.0", "::"]);
const URL_PAYLOAD_TYPES = new Set(["browser_navigate", "new_tab", "browser_new_tab", "browser_download", "browser_fetch_file"]);

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
}

export function validateLocalUrlHost(value: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error("MyBrowser local URL host must be a non-empty hostname or IP address");
  }

  let parsed: URL;
  try {
    parsed = new URL(`http://${value}`);
  } catch {
    throw new Error("MyBrowser local URL host must be a hostname or IP address without a scheme or port");
  }

  if (
    !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || INVALID_TARGET_HOSTS.has(normalizedHostname(parsed.hostname))
  ) {
    throw new Error("MyBrowser local URL host must be a browser-reachable hostname or IP address without a scheme or port");
  }
  return parsed.hostname;
}

export function resolveLocalUrl(rawUrl: string, localUrlHost?: string): string {
  if (!localUrlHost) return rawUrl;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (!LOOPBACK_HOSTS.has(normalizedHostname(url.hostname))) return rawUrl;

  url.hostname = localUrlHost;
  return url.toString();
}

export function resolveBrowserPayloadUrls(
  type: string,
  payload: unknown,
  localUrlHost?: string,
): unknown {
  if (!localUrlHost || typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return payload;
  }
  const record = payload as Record<string, unknown>;

  if (URL_PAYLOAD_TYPES.has(type) && typeof record.url === "string") {
    const url = resolveLocalUrl(record.url, localUrlHost);
    return url === record.url ? payload : { ...record, url };
  }
  if (type !== "browser_action" || !Array.isArray(record.steps)) return payload;

  let changed = false;
  const steps = record.steps.map((step) => {
    if (
      typeof step !== "object"
      || step === null
      || Array.isArray(step)
      || (step as Record<string, unknown>).action !== "navigate"
      || typeof (step as Record<string, unknown>).url !== "string"
    ) {
      return step;
    }
    const action = step as Record<string, unknown>;
    const url = resolveLocalUrl(action.url as string, localUrlHost);
    if (url === action.url) return step;
    changed = true;
    return { ...action, url };
  });
  return changed ? { ...record, steps } : payload;
}
