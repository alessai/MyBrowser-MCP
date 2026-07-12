import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  SERVER_RECORDING_STRING_METADATA,
  SERVER_RECORDING_NON_STRING_PATHS,
  sanitizeRecording,
  saveRecordingToFile,
} from "./record.js";

const SECRET_EXTRA = "SECRET_SERVER_DEFAULT_DENY_8341";
const SECRET_NESTED = "SECRET_SERVER_NESTED_9052";
const SECRET_FORM_KEY = "SECRET_SERVER_FORM_KEY_1276.label";

const requiredVariables = [
  { name: "navigation_1", source: "navigation", hint: "navigation_input_1" },
  { name: "input_2", source: "text", hint: "text_input_2" },
  { name: "select_3", source: "select", hint: "select_input_3" },
  { name: "form_4", source: "form", hint: "form_input_4" },
  { name: "input_5", source: "text", hint: "text_input_5" },
  { name: "clipboard_6", source: "clipboard", hint: "clipboard_input_6" },
] as const;

const actionArgs: Record<string, Record<string, unknown>> = {
  browser_navigate: { url: "{{navigation_1}}" },
  browser_go_back: {},
  browser_go_forward: {},
  browser_wait: {},
  browser_click: { element: "Account", selector: "#account" },
  browser_type: { element: "Password", text: "{{input_2}}" },
  browser_hover: { ref: "e42" },
  browser_press_key: { key: "Enter" },
  browser_drag: { startSelector: "#source", endSelector: "#target" },
  browser_select_option: { element: "Account", values: ["{{select_3}}"] },
  browser_set_viewport: { preset: "desktop", orientation: "landscape" },
  browser_reset_viewport: {},
  browser_fill_form: { fields: { [SECRET_FORM_KEY]: "{{form_4}}" }, submitText: "Continue" },
  browser_wait_for: { condition: "text_visible", value: "{{input_5}}", selector: "#status" },
  browser_clipboard: { action: "write", text: "{{clipboard_6}}" },
};

function recording() {
  return {
    name: "privacy-default-deny",
    startedAt: 1,
    stoppedAt: 2,
    url: "https://example.test/start",
    requiredVariables: requiredVariables.map((variable) => ({ ...variable })),
    steps: Object.entries(actionArgs).map(([action, args], index) => ({
      action,
      args: structuredClone(args),
      timestamp: index + 1,
      durationMs: 1,
      url: "https://example.test/current/path",
    })),
  };
}

function extensionRecordingMetadata(): {
  strings: Record<string, Record<string, string>>;
  nonStrings: Record<string, string[]>;
} {
  const source = readFileSync(
    resolve(process.cwd(), "../extension/src/lib/tool-metadata.ts"),
    "utf8",
  );
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, unknown> = {};
  Function("exports", javascript)(exports);
  const metadata = exports.TOOL_METADATA as Record<string, {
    recordable: boolean;
    recordingStrings?: Record<string, string>;
  }>;
  return {
    strings: Object.fromEntries(Object.entries(metadata)
    .filter(([, value]) => value.recordable)
    .map(([action, value]) => [action, value.recordingStrings ?? {}])),
    nonStrings: exports.RECORDING_NON_STRING_PATHS as Record<string, string[]>,
  };
}

describe("recording argument privacy", () => {
  it("keeps the server action map conformant with extension metadata", () => {
    const extension = extensionRecordingMetadata();
    expect(SERVER_RECORDING_STRING_METADATA).toEqual(extension.strings);
    expect(SERVER_RECORDING_NON_STRING_PATHS).toEqual(extension.nonStrings);
  });

  it("default-denies unclassified top-level and nested strings for every recordable action", () => {
    for (const action of Object.keys(actionArgs)) {
      const topLevel = recording();
      const step = topLevel.steps.find((candidate) => candidate.action === action)!;
      step.args.extra = `${SECRET_EXTRA}_${action}`;
      expect(() => sanitizeRecording(topLevel), action).toThrow("unsanitized action data");

      const keyCanary = recording();
      keyCanary.steps.find((candidate) => candidate.action === action)!.args[
        `SECRET_SERVER_UNKNOWN_KEY_${action}`
      ] = 1;
      expect(() => sanitizeRecording(keyCanary), action).toThrow("unsanitized action data");

      const nested = recording();
      const nestedStep = nested.steps.find((candidate) => candidate.action === action)!;
      nestedStep.args.extra = { deep: `${SECRET_NESTED}_${action}` };
      expect(() => sanitizeRecording(nested), action).toThrow("unsanitized action data");
    }
  });

  it("requires placeholders for every sensitive value class while allowing classified form keys", () => {
    const probes: Array<[string, (args: Record<string, unknown>) => void]> = [
      ["browser_type", (args) => { args.text = "SECRET_RAW_TYPE_4410"; }],
      ["browser_fill_form", (args) => { args.fields = { [SECRET_FORM_KEY]: "SECRET_RAW_FORM_6624" }; }],
      ["browser_select_option", (args) => { args.values = ["SECRET_RAW_SELECT_7815"]; }],
      ["browser_navigate", (args) => { args.url = "https://user:SECRET_RAW_URL_2936@example.test/path"; }],
      ["browser_clipboard", (args) => { args.text = "SECRET_RAW_CLIPBOARD_5187"; }],
    ];
    const sanitizedFields = sanitizeRecording(recording()).steps
      .find((step) => step.action === "browser_fill_form")?.args.fields as Record<string, unknown>;
    expect(sanitizedFields[SECRET_FORM_KEY]).toBe("{{form_4}}");
    for (const [action, mutate] of probes) {
      const candidate = recording();
      mutate(candidate.steps.find((step) => step.action === action)!.args);
      expect(() => sanitizeRecording(candidate), action).toThrow("unsanitized action data");
    }
  });

  it("preserves accepted origin plus pathname metadata but rejects URL secrets", () => {
    const candidate = recording();
    candidate.url = "https://example.test/accounts/42";
    candidate.steps.push({
      action: "browser_navigate",
      args: { url: "https://example.test/orders/7" },
      timestamp: 100,
      durationMs: 1,
      url: "https://example.test/current/path",
    });
    expect(sanitizeRecording(candidate)).toMatchObject({
      url: "https://example.test/accounts/42",
      steps: expect.arrayContaining([expect.objectContaining({
        action: "browser_navigate",
        args: { url: "https://example.test/orders/7" },
      })]),
    });
    for (const url of [
      "https://user:pass@example.test/orders/7",
      "https://example.test/orders/7?token=private",
      "https://example.test/orders/7#private",
    ]) {
      const unsafe = recording();
      unsafe.steps.push({
        action: "browser_navigate",
        args: { url },
        timestamp: 100,
        durationMs: 1,
        url: "https://example.test/current/path",
      });
      expect(() => sanitizeRecording(unsafe)).toThrow("unsanitized action data");
    }
  });

  it("never passes an unclassified canary to disk operations", () => {
    const candidate = recording();
    candidate.steps[0]!.args.extra = SECRET_EXTRA;
    let diskTouched = false;
    expect(() => saveRecordingToFile(candidate, "/unused", {
      openSync: () => {
        diskTouched = true;
        throw new Error("DISK_TOUCHED");
      },
    })).toThrow("unsanitized action data");
    expect(diskTouched).toBe(false);
  });
});
