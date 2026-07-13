export const V2_SESSION_ID_PATTERN = '^[A-Za-z0-9_-]{1,128}$';
const V2_SESSION_ID_REGEX = new RegExp(V2_SESSION_ID_PATTERN);

export function isValidV2SessionId(value: unknown): value is string {
  return typeof value === 'string' && V2_SESSION_ID_REGEX.test(value);
}
