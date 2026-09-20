export interface ConnectionSettings {
  serverAddress: string;
  serverPort: number;
  authToken: string;
}

export interface ConnectionTarget {
  url: string;
  token: string;
}

export function isLoopbackAddress(host: string): boolean {
  const normalized = (host.trim() || '127.0.0.1')
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function resolveNavigationUrl(rawUrl: string, localUrlHost: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (!isLoopbackAddress(url.hostname) || !localUrlHost.trim()) return rawUrl;

  let target: URL;
  try {
    target = new URL(`http://${localUrlHost.trim()}`);
  } catch {
    throw new Error('LOCAL_URL_HOST_INVALID');
  }
  if (
    !target.hostname
    || target.username
    || target.password
    || target.port
    || target.pathname !== '/'
    || target.search
    || target.hash
    || isLoopbackAddress(target.hostname)
  ) {
    throw new Error('LOCAL_URL_HOST_INVALID');
  }

  url.hostname = target.hostname;
  return url.toString();
}

// Explicit ws:// or wss:// hub URL override (e.g. imported from mybrowser.local.json)
const WS_URL_RE = /^wss?:\/\//i;

export function resolveConnectionTarget(settings: ConnectionSettings): ConnectionTarget | null {
  const rawAddress = settings.serverAddress.trim();

  // Explicit scheme: passthrough the full URL as given (no behavior change for ws://).
  if (WS_URL_RE.test(rawAddress)) {
    let parsed: URL;
    try {
      parsed = new URL(rawAddress);
    } catch {
      return null;
    }
    if (!parsed.hostname || (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:')
      || parsed.username || parsed.password) return null;
    if (!settings.authToken && !isLoopbackAddress(parsed.hostname)) return null;
    return { url: `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`, token: settings.authToken };
  }

  const host = rawAddress || '127.0.0.1';
  if (!Number.isInteger(settings.serverPort) || settings.serverPort < 1 || settings.serverPort > 65_535) {
    return null;
  }
  if (!settings.authToken && !isLoopbackAddress(host)) return null;
  const urlHost = host === '::1' ? '[::1]' : host;
  return { url: `ws://${urlHost}:${settings.serverPort}`, token: settings.authToken };
}
