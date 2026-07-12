import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  SERVER_RECORDING_ARGUMENT_TYPES,
  SERVER_RECORDING_STRING_METADATA,
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
  types: Record<string, Record<string, string>>;
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
    types: exports.RECORDING_ARGUMENT_TYPES as Record<string, Record<string, string>>,
  };
}

describe("recording argument privacy", () => {
  it("keeps the server action map conformant with extension metadata", () => {
    const extension = extensionRecordingMetadata();
    expect(SERVER_RECORDING_STRING_METADATA).toEqual(extension.strings);
    expect(SERVER_RECORDING_ARGUMENT_TYPES).toEqual(extension.types);
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

  it("default-denies wrong primitive and container types for every recordable action", () => {
    const probes: Record<string, (args: Record<string, unknown>) => void> = {
      browser_navigate: (args) => { args.tabId = true; },
      browser_go_back: (args) => { args.tabId = true; },
      browser_go_forward: (args) => { args.tabId = null; },
      browser_wait: (args) => { args.time = null; },
      browser_click: (args) => { args.mark = true; },
      browser_type: (args) => { args.submit = 1; },
      browser_hover: (args) => { args.mark = false; },
      browser_press_key: (args) => { args.tabId = false; },
      browser_drag: (args) => { args.startMark = true; },
      browser_select_option: (args) => { args.mark = false; },
      browser_set_viewport: (args) => { args.tabId = false; },
      browser_reset_viewport: (args) => { args.tabId = false; },
      browser_fill_form: (args) => { args.submitAfter = 1; },
      browser_wait_for: (args) => { args.timeout = null; },
      browser_clipboard: (args) => { args.tabId = false; },
    };
    expect(Object.keys(probes).sort()).toEqual(Object.keys(actionArgs).sort());

    for (const [action, mutate] of Object.entries(probes)) {
      const candidate = recording();
      mutate(candidate.steps.find((step) => step.action === action)!.args);
      expect(() => sanitizeRecording(candidate), action).toThrow("unsanitized action data");
    }

    for (const invalidTime of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const candidate = recording();
      candidate.steps.find((step) => step.action === "browser_wait")!.args.time = invalidTime;
      expect(() => sanitizeRecording(candidate)).toThrow("unsanitized action data");
    }
    for (const invalidValues of [[1], ["{{select_3}}", null], {}]) {
      const candidate = recording();
      candidate.steps.find((step) => step.action === "browser_select_option")!.args.values = invalidValues;
      expect(() => sanitizeRecording(candidate)).toThrow("unsanitized action data");
    }
    for (const invalidFields of [[], { Account: null }, null]) {
      const candidate = recording();
      candidate.steps.find((step) => step.action === "browser_fill_form")!.args.fields = invalidFields;
      expect(() => sanitizeRecording(candidate)).toThrow("unsanitized action data");
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

  it("allows only HTTP(S) residual metadata and rejects explicit non-web navigation", () => {
    const explicitEmpty = recording();
    explicitEmpty.steps = [{
      action: "browser_navigate",
      args: { url: "" },
      timestamp: 1,
      durationMs: 1,
      url: "",
    }];
    explicitEmpty.requiredVariables = [];
    expect(() => sanitizeRecording(explicitEmpty)).toThrow("unsanitized action data");

    for (const url of [
      "http://example.test/orders/7",
      "https://example.test/orders/7",
    ]) {
      const candidate = recording();
      candidate.url = url;
      candidate.steps[0]!.url = url;
      expect(sanitizeRecording(candidate)).toMatchObject({ url });
    }

    for (const url of [
      "chrome://settings/passwords",
      "about:blank",
      "file:///tmp/SECRET_SERVER_FILE_URL_3021",
      "data:text/plain,SECRET_SERVER_DATA_URL_4132",
      "javascript:alert('SECRET_SERVER_JS_URL_5243')",
      "custom-scheme://host/SECRET_SERVER_CUSTOM_URL_6354",
    ]) {
      const explicit = recording();
      explicit.steps.find((step) => step.action === "browser_navigate")!.args.url = url;
      expect(() => sanitizeRecording(explicit), url).toThrow("unsanitized action data");

      const passive = recording();
      passive.url = url;
      expect(() => sanitizeRecording(passive), url).toThrow("unsanitized action data");
      passive.url = "";
      passive.steps[0]!.url = "";
      expect(sanitizeRecording(passive)).toMatchObject({ url: "" });
    }
  });

  it("strictly rejects secret-bearing unknown fields before persistence at every fixed level", () => {
    const candidates = [
      () => Object.assign(recording(), { unknownTop: "SECRET_FIXED_TOP_7465" }),
      () => {
        const candidate = recording();
        Object.assign(candidate.steps[0]!, { unknownStep: "SECRET_FIXED_STEP_8576" });
        return candidate;
      },
      () => {
        const candidate = recording();
        Object.assign(candidate.requiredVariables[0]!, {
          unknownVariable: "SECRET_FIXED_VARIABLE_9687",
        });
        return candidate;
      },
    ];

    for (const createCandidate of candidates) {
      expect(() => sanitizeRecording(createCandidate())).toThrow();
      let diskTouched = false;
      expect(() => saveRecordingToFile(createCandidate(), "/unused", {
        openSync: () => {
          diskTouched = true;
          throw new Error("DISK_TOUCHED");
        },
      })).toThrow();
      expect(diskTouched).toBe(false);
    }
  });

  it("accepts omitted generic hints and rejects invalid hints or persisted numeric bounds", () => {
    const withoutHints = recording();
    for (const variable of withoutHints.requiredVariables) delete (variable as { hint?: string }).hint;
    expect(sanitizeRecording(withoutHints).requiredVariables.every((variable) => (
      variable.hint === undefined
    ))).toBe(true);

    const invalidHint = recording();
    (invalidHint.requiredVariables[0]! as { hint?: string }).hint = "Account field";
    expect(() => sanitizeRecording(invalidHint)).toThrow();

    const mutations: Array<(candidate: ReturnType<typeof recording>) => void> = [
      (candidate) => { candidate.startedAt = -1; },
      (candidate) => { candidate.startedAt = Number.POSITIVE_INFINITY; },
      (candidate) => { candidate.stoppedAt = -1; },
      (candidate) => { candidate.stoppedAt = Number.NaN; },
      (candidate) => { candidate.steps[0]!.timestamp = -1; },
      (candidate) => { candidate.steps[0]!.timestamp = Number.POSITIVE_INFINITY; },
      (candidate) => { candidate.steps[0]!.durationMs = -1; },
      (candidate) => { candidate.steps[0]!.durationMs = Number.NaN; },
    ];
    for (const mutate of mutations) {
      const candidate = recording();
      mutate(candidate);
      expect(() => sanitizeRecording(candidate)).toThrow();
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
