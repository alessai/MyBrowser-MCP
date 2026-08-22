import { spawn } from "node:child_process";
import net from "node:net";

export const HUB_AUTOSTART_TOKEN_ENV = "MYBROWSER_INTERNAL_HUB_TOKEN";

export interface DetachedHubOptions {
  host: string;
  port: number;
  token: string;
  entrypoint: string;
  startupTimeoutMs?: number;
}

interface DetachedHubDependencies {
  isListening: (host: string, port: number) => Promise<boolean>;
  spawnHub: (options: DetachedHubOptions) => void;
  sleep: (delayMs: number) => Promise<void>;
}

export function assertLoopbackHubHost(host: string): void {
  if (!["127.0.0.1", "::1", "localhost"].includes(host.toLowerCase())) {
    throw new Error("--ensure-hub requires a loopback host");
  }
}

function isListening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export function buildHubEnvironment(token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { [HUB_AUTOSTART_TOKEN_ENV]: token };
  for (const key of [
    "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
    "TEMP", "TMP", "TMPDIR", "SystemRoot", "SYSTEMROOT", "LANG", "LC_ALL",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function spawnHub(options: DetachedHubOptions): void {
  const child = spawn(
    process.execPath,
    [options.entrypoint, "--hub", "--host", options.host, "--port", String(options.port)],
    {
      detached: true,
      env: buildHubEnvironment(options.token),
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.once("error", () => undefined);
  child.unref();
}

const defaultDependencies: DetachedHubDependencies = {
  isListening,
  spawnHub,
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
};

export function createDetachedHubEnsurer(
  options: DetachedHubOptions,
  dependencies: DetachedHubDependencies = defaultDependencies,
): () => Promise<void> {
  assertLoopbackHubHost(options.host);
  let inFlight: Promise<void> | undefined;
  return () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      if (await dependencies.isListening(options.host, options.port)) return;
      dependencies.spawnHub(options);
      const deadline = Date.now() + (options.startupTimeoutMs ?? 10_000);
      while (Date.now() < deadline) {
        await dependencies.sleep(100);
        if (await dependencies.isListening(options.host, options.port)) return;
      }
      throw new Error(`Detached hub did not start on ${options.host}:${options.port}`);
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
