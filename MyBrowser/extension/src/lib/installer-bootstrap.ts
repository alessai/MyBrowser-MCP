const BOOTSTRAP_FILE = "mybrowser.local.json";
const IMPORTED_ID_KEY = "installerBootstrapId";
const BOOTSTRAP_FIELDS = [
  "authToken",
  "bootstrapId",
  "browserName",
  "schemaVersion",
  "serverAddress",
  "serverPort",
] as const;

interface InstallerBootstrap {
  schemaVersion: 1;
  bootstrapId: string;
  serverAddress: "127.0.0.1";
  serverPort: number;
  authToken: string;
  browserName: string;
}

interface InstallerBootstrapDependencies {
  read: () => Promise<unknown | null>;
  getImportedId: () => Promise<unknown>;
  write: (values: Record<string, unknown>) => Promise<void>;
}

export type InstallerBootstrapResult = "missing" | "invalid" | "unchanged" | "imported";

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function parseInstallerBootstrap(value: unknown): InstallerBootstrap | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== BOOTSTRAP_FIELDS.length
    || !BOOTSTRAP_FIELDS.every((field, index) => keys[index] === field)) return null;

  if (record.schemaVersion !== 1
    || typeof record.bootstrapId !== "string"
    || !/^[0-9a-f]{32}$/u.test(record.bootstrapId)
    || record.serverAddress !== "127.0.0.1"
    || typeof record.serverPort !== "number"
    || !Number.isInteger(record.serverPort)
    || record.serverPort < 1
    || record.serverPort > 65535
    || !isBoundedText(record.authToken, 512)
    || !isBoundedText(record.browserName, 128)) return null;

  return record as unknown as InstallerBootstrap;
}

export async function applyInstallerBootstrap(
  dependencies: InstallerBootstrapDependencies,
): Promise<InstallerBootstrapResult> {
  const value = await dependencies.read();
  if (value === null) return "missing";
  const bootstrap = parseInstallerBootstrap(value);
  if (!bootstrap) return "invalid";

  if (await dependencies.getImportedId() === bootstrap.bootstrapId) return "unchanged";
  await dependencies.write({
    serverAddress: bootstrap.serverAddress,
    serverPort: bootstrap.serverPort,
    authToken: bootstrap.authToken,
    browserName: bootstrap.browserName,
    [IMPORTED_ID_KEY]: bootstrap.bootstrapId,
  });
  return "imported";
}

export async function importInstallerBootstrap(): Promise<InstallerBootstrapResult> {
  return applyInstallerBootstrap({
    read: async () => {
      const response = await fetch(chrome.runtime.getURL(BOOTSTRAP_FILE), { cache: "no-store" });
      if (!response.ok) return null;
      return response.json() as Promise<unknown>;
    },
    getImportedId: async () => {
      const stored = await chrome.storage.local.get(IMPORTED_ID_KEY);
      return stored[IMPORTED_ID_KEY];
    },
    write: (values) => chrome.storage.local.set(values),
  });
}
