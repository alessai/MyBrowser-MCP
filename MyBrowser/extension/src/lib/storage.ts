// Typed chrome.storage.local definitions

export interface StorageSchema {
  serverAddress: string;
  serverPort: number;
  authToken: string;
  browserName: string;
}

const DEFAULTS: StorageSchema = {
  serverAddress: '',
  serverPort: 9009,
  authToken: '',
  browserName: '',
};

export async function getStorage<K extends keyof StorageSchema>(
  key: K,
): Promise<StorageSchema[K]> {
  const result = await chrome.storage.local.get(key);
  return (result[key] as StorageSchema[K]) ?? DEFAULTS[key];
}

export async function getStorageAll(): Promise<StorageSchema> {
  const result = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...result } as StorageSchema;
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
