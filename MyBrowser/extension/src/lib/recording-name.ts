export function canonicalizeRecordingName(name: string): string {
  const normalized = name.trim().replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!normalized || normalized === '.' || normalized === '..') {
    throw new Error('INVALID_RECORDING_NAME');
  }
  return normalized;
}
