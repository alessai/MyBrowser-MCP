import { describe, expect, it } from "vitest";

import { TELEMETRY_TOOL_POLICIES } from "./policies.js";
import {
  summarizeDiagnosticsArguments,
  summarizeToolArguments,
} from "./sanitize.js";

const CANARY = "RAW_SECRET_CANARY_7f3d";
const KEY_A = Buffer.alloc(32, 0x11);
const KEY_B = Buffer.alloc(32, 0x22);

describe("telemetry argument sanitization", () => {
  it.each([
    ["browser_type", { text: CANARY, element: CANARY, submit: true, tabId: 42 }],
    ["browser_fill_form", { fields: { [CANARY]: CANARY }, submitText: CANARY }],
    ["browser_clipboard", { action: "write", text: CANARY }],
    ["browser_storage", { action: "set", key: CANARY, value: CANARY }],
    ["browser_eval", { code: CANARY, timeout: 5_000 }],
    ["browser_upload", { files: [`/private/${CANARY}.txt`] }],
    ["browser_notes_archive", { id: CANARY, resolution: CANARY }],
    ["browser_shared_set", { key: CANARY, value: { [CANARY]: CANARY } }],
    ["browser_on", { event: "dialog", options: { promptText: CANARY } }],
    ["browser_handoff", { toSession: CANARY, message: CANARY }],
  ])("never serializes raw sensitive arguments for %s", (toolName, args) => {
    const serialized = JSON.stringify(summarizeToolArguments(toolName, args, KEY_A));

    expect(serialized).not.toContain(CANARY);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(16 * 1024);
  });

  it("keeps URL origin but pseudonymizes path and discards query, fragment, and credentials", () => {
    const { summary } = summarizeToolArguments(
      "browser_navigate",
      {
        url: `https://user:${CANARY}@example.test/private/${CANARY}?token=${CANARY}#${CANARY}`,
        tabId: 9,
      },
      KEY_A,
    );
    const serialized = JSON.stringify(summary);

    expect(summary.scalar["url.origin"]).toBe("https://example.test");
    expect(summary.pseudonyms["url.path"]).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(serialized).not.toContain("/private/");
    expect(serialized).not.toContain("token=");
    expect(serialized).not.toContain(CANARY);
  });

  it("uses stable keyed pseudonyms and separates different install keys", () => {
    const args = { name: CANARY, tabId: 17 };
    const first = summarizeToolArguments("browser_record_start", args, KEY_A);
    const second = summarizeToolArguments("browser_record_start", args, KEY_A);
    const otherInstall = summarizeToolArguments("browser_record_start", args, KEY_B);

    expect(first).toEqual(second);
    expect(first.fingerprint).not.toBe(otherInstall.fingerprint);
    expect(first.summary.pseudonyms.name).not.toBe(otherInstall.summary.pseudonyms.name);
  });

  it("canonicalizes summaries independently of argument property order", () => {
    const first = summarizeToolArguments(
      "browser_type",
      { tabId: 3, submit: true, text: CANARY, element: "target" },
      KEY_A,
    );
    const second = summarizeToolArguments(
      "browser_type",
      { element: "target", text: CANARY, submit: true, tabId: 3 },
      KEY_A,
    );

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.summary).toEqual(second.summary);
  });

  it("summarizes real browser_action steps without retaining nested values", () => {
    const result = summarizeToolArguments("browser_action", {
      tabId: 3,
      stopOnError: false,
      steps: [
        { action: "type", typedText: CANARY, selector: CANARY },
        { action: "navigate", url: `https://example.test/${CANARY}` },
      ],
    }, KEY_A);
    const serialized = JSON.stringify(result);

    expect(result.summary.scalar).toMatchObject({
      "steps.kinds": "type,navigate",
      stopOnError: false,
    });
    expect(result.summary.counts.steps).toBe(2);
    expect(serialized).not.toContain(CANARY);
  });

  it("is bounded and non-throwing for hostile, circular, and oversized input", () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "text", {
      enumerable: true,
      get: () => {
        throw new Error(CANARY);
      },
    });
    hostile.self = hostile;
    hostile.fields = new Proxy({}, {
      ownKeys: () => {
        throw new Error(CANARY);
      },
    });
    hostile.element = CANARY.repeat(100_000);

    expect(() => summarizeToolArguments("browser_type", hostile, KEY_A)).not.toThrow();
    const result = summarizeToolArguments("browser_type", hostile, KEY_A);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("deep-freezes summaries so callers cannot append raw values", () => {
    const { summary } = summarizeToolArguments("browser_type", { text: CANARY }, KEY_A);

    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.presence)).toBe(true);
    expect(Object.isFrozen(summary.scalar)).toBe(true);
    expect(Object.isFrozen(summary.counts)).toBe(true);
    expect(Object.isFrozen(summary.pseudonyms)).toBe(true);
  });

  it("keeps every policy output under the event cap for oversized inputs", () => {
    for (const [toolName, policy] of Object.entries(TELEMETRY_TOOL_POLICIES)) {
      const args: Record<string, unknown> = {};
      for (const [field, rule] of Object.entries(policy.fields)) {
        args[field] =
          rule.kind === "count" || rule.kind === "action_sequence"
            ? Array.from({ length: 5_000 }, () => ({ action: CANARY, value: CANARY }))
            : rule.kind === "boolean"
              ? true
              : rule.kind === "number"
                ? Number.MAX_VALUE
                : rule.kind === "shape"
                  ? { [CANARY]: CANARY }
                  : CANARY.repeat(5_000);
      }

      const serialized = JSON.stringify(summarizeToolArguments(toolName, args, KEY_A));
      expect(Buffer.byteLength(serialized, "utf8"), toolName).toBeLessThanOrEqual(16 * 1024);
      expect(serialized, toolName).not.toContain(CANARY);
    }
  });

  it("fails closed for unknown telemetry policies but diagnostics never throw", () => {
    expect(() => summarizeToolArguments("browser_unknown", { secret: CANARY }, KEY_A))
      .toThrow(/policy/iu);
    expect(() => summarizeDiagnosticsArguments("browser_unknown", { secret: CANARY }))
      .not.toThrow();
    expect(JSON.stringify(summarizeDiagnosticsArguments("browser_unknown", { secret: CANARY })))
      .not.toContain(CANARY);
  });

  it("returns only the explicit failure marker when diagnostics sanitization throws", () => {
    const hostileToolName = new Proxy({}, {
      get: () => {
        throw new Error(CANARY);
      },
    }) as unknown as string;

    expect(summarizeDiagnosticsArguments(hostileToolName, { secret: CANARY })).toEqual({
      sanitizer: "failed",
      dropped: true,
    });
  });
});
