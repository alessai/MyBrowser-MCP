import { readFileSync } from "node:fs";

const MAX_RECORDING_BYTES = 2 * 1024 * 1024;
const UNSUPPORTED_REPLAY_ACTIONS = new Set([
  "new_tab",
  "select_tab",
  "close_tab",
  "browser_new_tab",
  "browser_select_tab",
  "browser_close_tab",
]);

export interface RecordingListEntry {
  name: string;
  compatible: boolean;
  reason?: "RECORDING_UNSUPPORTED_MULTI_TAB" | "RECORDING_INVALID";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

class RecordingActionScanner {
  private index = 0;
  private malformed = false;
  private unsupported = false;

  constructor(private readonly source: string) {}

  inspect(): Omit<RecordingListEntry, "name"> {
    try {
      this.skipWhitespace();
      this.parseRoot();
      this.skipWhitespace();
      if (this.index !== this.source.length) throw new Error("invalid");
    } catch {
      this.malformed = true;
    }
    if (this.unsupported) {
      return { compatible: false, reason: "RECORDING_UNSUPPORTED_MULTI_TAB" };
    }
    return this.malformed
      ? { compatible: false, reason: "RECORDING_INVALID" }
      : { compatible: true };
  }

  private parseRoot(): void {
    this.expect("{");
    this.skipWhitespace();
    let sawSteps = false;
    if (this.consume("}")) {
      this.malformed = true;
      return;
    }
    while (true) {
      const key = this.parseString(true);
      this.skipWhitespace();
      this.expect(":");
      this.skipWhitespace();
      if (key === "steps") {
        if (sawSteps) this.malformed = true;
        sawSteps = true;
        this.parseSteps();
      } else {
        this.skipValue();
      }
      this.skipWhitespace();
      if (this.consume("}")) break;
      this.expect(",");
      this.skipWhitespace();
    }
    if (!sawSteps) this.malformed = true;
  }

  private parseSteps(): void {
    this.expect("[");
    this.skipWhitespace();
    if (this.consume("]")) return;
    while (true) {
      if (this.source[this.index] === "{") this.parseStep();
      else {
        this.malformed = true;
        this.skipValue();
      }
      this.skipWhitespace();
      if (this.consume("]")) return;
      this.expect(",");
      this.skipWhitespace();
    }
  }

  private parseStep(): void {
    this.expect("{");
    this.skipWhitespace();
    let sawAction = false;
    if (this.consume("}")) {
      this.malformed = true;
      return;
    }
    while (true) {
      const key = this.parseString(true);
      this.skipWhitespace();
      this.expect(":");
      this.skipWhitespace();
      if (key === "action") {
        if (sawAction) this.malformed = true;
        sawAction = true;
        if (this.source[this.index] === "\"") {
          const action = this.parseString(true);
          if (UNSUPPORTED_REPLAY_ACTIONS.has(action)) this.unsupported = true;
        } else {
          this.malformed = true;
          this.skipValue();
        }
      } else {
        this.skipValue();
      }
      this.skipWhitespace();
      if (this.consume("}")) break;
      this.expect(",");
      this.skipWhitespace();
    }
    if (!sawAction) this.malformed = true;
  }

  private skipValue(): void {
    this.skipWhitespace();
    const current = this.source[this.index];
    if (current === "\"") {
      this.parseString(false);
      return;
    }
    if (current === "{") {
      this.index += 1;
      this.skipWhitespace();
      if (this.consume("}")) return;
      while (true) {
        this.parseString(false);
        this.skipWhitespace();
        this.expect(":");
        this.skipValue();
        this.skipWhitespace();
        if (this.consume("}")) return;
        this.expect(",");
        this.skipWhitespace();
      }
    }
    if (current === "[") {
      this.index += 1;
      this.skipWhitespace();
      if (this.consume("]")) return;
      while (true) {
        this.skipValue();
        this.skipWhitespace();
        if (this.consume("]")) return;
        this.expect(",");
        this.skipWhitespace();
      }
    }
    for (const literal of ["true", "false", "null"]) {
      if (this.source.startsWith(literal, this.index)) {
        this.index += literal.length;
        return;
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.source.slice(this.index),
    );
    if (!number) throw new Error("invalid");
    this.index += number[0].length;
  }

  private parseString(capture: boolean): string {
    const start = this.index;
    this.expect("\"");
    while (this.index < this.source.length) {
      const character = this.source[this.index]!;
      if (character === "\"") {
        this.index += 1;
        if (!capture) return "";
        try {
          return JSON.parse(this.source.slice(start, this.index)) as string;
        } catch {
          throw new Error("invalid");
        }
      }
      if (character === "\\") {
        this.index += 1;
        const escape = this.source[this.index];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(this.source.slice(this.index + 1, this.index + 5))) {
            throw new Error("invalid");
          }
          this.index += 5;
          continue;
        }
        if (!escape || !'\"\\/bfnrt'.includes(escape)) throw new Error("invalid");
        this.index += 1;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) throw new Error("invalid");
      this.index += 1;
    }
    throw new Error("invalid");
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.source[this.index] ?? "")) this.index += 1;
  }

  private consume(character: string): boolean {
    if (this.source[this.index] !== character) return false;
    this.index += 1;
    return true;
  }

  private expect(character: string): void {
    if (!this.consume(character)) throw new Error("invalid");
  }
}

export function inspectRecordingFile(
  filePath: string,
  expectedName: string,
  validate: (value: unknown) => { name: string },
): Omit<RecordingListEntry, "name"> {
  try {
    const source = readFileSync(filePath, "utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_RECORDING_BYTES) {
      return { compatible: false, reason: "RECORDING_INVALID" };
    }
    const actionCompatibility = new RecordingActionScanner(source).inspect();
    if (!actionCompatibility.compatible) return actionCompatibility;
    const recording = validate(JSON.parse(source) as unknown);
    return recording.name === expectedName
      ? { compatible: true }
      : { compatible: false, reason: "RECORDING_INVALID" };
  } catch {
    return { compatible: false, reason: "RECORDING_INVALID" };
  }
}

export function parseExtensionRecordingList(value: unknown): RecordingListEntry[] {
  if (!isPlainRecord(value) || !Array.isArray(value.recordings)) return [];
  const entries: RecordingListEntry[] = [];
  for (const candidate of value.recordings) {
    if (!isPlainRecord(candidate)
      || typeof candidate.name !== "string"
      || typeof candidate.compatible !== "boolean") continue;
    if (candidate.compatible) {
      entries.push({ name: candidate.name, compatible: true });
    } else if (candidate.reason === "RECORDING_UNSUPPORTED_MULTI_TAB"
      || candidate.reason === "RECORDING_INVALID") {
      entries.push({ name: candidate.name, compatible: false, reason: candidate.reason });
    }
  }
  return entries;
}

export function mergeRecordingEntries(entries: RecordingListEntry[]): RecordingListEntry[] {
  const merged = new Map<string, RecordingListEntry>();
  for (const entry of entries) {
    const existing = merged.get(entry.name);
    if (!existing || (existing.compatible && !entry.compatible)
      || (existing.reason === "RECORDING_INVALID"
        && entry.reason === "RECORDING_UNSUPPORTED_MULTI_TAB")) {
      merged.set(entry.name, entry);
    }
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}
