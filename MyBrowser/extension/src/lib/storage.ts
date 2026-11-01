// Typed chrome.storage.local definitions

import { isLoopbackAddress } from './local-connection';

export interface StorageSchema {
  serverAddress: string;
  serverPort: number;
  authToken: string;
  browserName: string;
  localUrlHost: string;
  /** Popup switch: false disconnects from the MCP server and refuses every tool request. */
  accessEnabled: boolean;
}

const DEFAULTS: StorageSchema = {
  serverAddress: '127.0.0.1',
  serverPort: 9009,
  authToken: '',
  browserName: '',
  localUrlHost: '',
  accessEnabled: true,
};

// Only an explicit false turns access off; a missing or corrupt value keeps today's behaviour.
export async function isAccessEnabled(): Promise<boolean> {
  const { accessEnabled } = await chrome.storage.local.get('accessEnabled');
  return accessEnabled !== false;
}

function localUrlHostFromStored(result: Partial<StorageSchema>): string {
  if (Object.prototype.hasOwnProperty.call(result, 'localUrlHost')) {
    return typeof result.localUrlHost === 'string' ? result.localUrlHost : '';
  }
  const serverAddress = typeof result.serverAddress === 'string'
    ? result.serverAddress.trim()
    : DEFAULTS.serverAddress;
  return isLoopbackAddress(serverAddress) ? '' : serverAddress;
}

export async function getStorage<K extends keyof StorageSchema>(
  key: K,
): Promise<StorageSchema[K]> {
  const result = await chrome.storage.local.get(key);
  return (result[key] as StorageSchema[K]) ?? DEFAULTS[key];
}

export async function getStorageAll(): Promise<StorageSchema> {
  const result = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...result, localUrlHost: localUrlHostFromStored(result), accessEnabled: result.accessEnabled !== false } as StorageSchema;
}

export async function getLocalUrlHost(): Promise<string> {
  const result = await chrome.storage.local.get(['localUrlHost', 'serverAddress']);
  return localUrlHostFromStored(result);
}

export async function setStorage<K extends keyof StorageSchema>(
  key: K,
  value: StorageSchema[K],
): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function setStorageAll(
  values: Partial<StorageSchema>,
): Promise<void> {
  await chrome.storage.local.set(values);
}
