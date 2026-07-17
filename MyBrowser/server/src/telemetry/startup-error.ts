const MAX_STARTUP_ERROR_BYTES = 512;
const MAX_INPUT_CODE_UNITS = 2_048;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/gu;
const WHITESPACE = /\s+/gu;

function ownErrorMessage(error: unknown): string | undefined {
  try {
    if (!(error instanceof Error)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    return descriptor && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

export function formatStartupFailure(error: unknown): string {
  const raw = ownErrorMessage(error);
  if (raw === undefined) return "Unknown startup failure";

  const normalized = raw
    .slice(0, MAX_INPUT_CODE_UNITS)
    .replace(CONTROL_CHARACTERS, " ")
    .replace(WHITESPACE, " ")
    .trim();

  return truncateUtf8(normalized || "Unknown startup failure", MAX_STARTUP_ERROR_BYTES);
}
