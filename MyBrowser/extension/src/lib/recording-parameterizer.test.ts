import { describe, expect, it } from "vitest";

import {
  parameterizeArgs,
  sanitizePageUrl,
  type ParameterizationState,
} from "./recording-parameterizer";
import { TOOL_METADATA } from "./tool-metadata";

const SECRET_TEXT = "SECRET_ALPHA_9271";
const SECRET_FORM = "SECRET_BRAVO_4382";
const SECRET_SELECT = "SECRET_CHARLIE_6150";
const SECRET_NAVIGATION = "SECRET_DELTA_7043";
const SECRET_CLIPBOARD = "SECRET_ECHO_2894";

function expectAbsent(value: unknown, secrets: string[]): void {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) expect(serialized).not.toContain(secret);
}

describe("parameterizeArgs", () => {
  it("replaces sensitive values with deterministic placeholders without a reverse map", () => {
    const state: ParameterizationState = { nextVariable: 1 };

    const typed = parameterizeArgs("browser_type", {
      element: "Password field",
      label: "Password",
      text: SECRET_TEXT,
      submit: true,
    }, state);
    const form = parameterizeArgs("browser_fill_form", {
      fields: { "Email.Address": SECRET_FORM },
      submitText: "Continue",
    }, state);
    const selected = parameterizeArgs("browser_select_option", {
      element: "Account selector",
      values: [SECRET_SELECT],
    }, state);
    const navigation = parameterizeArgs("browser_navigate", {
      url: `https://user:pass@example.test/private?token=${SECRET_NAVIGATION}#receipt`,
    }, state);
    const clipboard = parameterizeArgs("browser_clipboard", {
      action: "write",
      text: SECRET_CLIPBOARD,
    }, state);

    expect(typed).toEqual({
      args: {
        element: "Password field",
        label: "Password",
        text: "{{input_1}}",
        submit: true,
      },
      requiredVariables: [{ name: "input_1", source: "text", hint: "text_input_1" }],
    });
    expect(form).toEqual({
      args: { fields: { "Email.Address": "{{form_2}}" }, submitText: "Continue" },
      requiredVariables: [{ name: "form_2", source: "form", hint: "form_input_2" }],
    });
    expect(selected).toEqual({
      args: { element: "Account selector", values: ["{{select_3}}"] },
      requiredVariables: [{ name: "select_3", source: "select", hint: "select_input_3" }],
    });
    expect(navigation).toEqual({
      args: { url: "{{navigation_4}}" },
      requiredVariables: [{ name: "navigation_4", source: "navigation", hint: "navigation_input_4" }],
    });
    expect(clipboard).toEqual({
      args: { action: "write", text: "{{clipboard_5}}" },
      requiredVariables: [{ name: "clipboard_5", source: "clipboard", hint: "clipboard_input_5" }],
    });
    expect(state).toEqual({ nextVariable: 6 });
    expectAbsent(
      { typed, form, selected, navigation, clipboard, state },
      [SECRET_TEXT, SECRET_FORM, SECRET_SELECT, SECRET_NAVIGATION, SECRET_CLIPBOARD],
    );
  });

  it("parameterizes content strings while retaining explicitly safe target structure", () => {
    const state: ParameterizationState = { nextVariable: 1 };
    const result = parameterizeArgs("browser_wait_for", {
      condition: "text_visible",
      value: SECRET_TEXT,
      selector: "#status",
      timeout: 2_000,
    }, state);

    expect(result.args).toEqual({
      condition: "text_visible",
      value: "{{input_1}}",
      selector: "#status",
      timeout: 2_000,
    });
    expectAbsent(result, [SECRET_TEXT]);
  });

  it("keeps a non-sensitive navigation target as origin plus pathname", () => {
    const state: ParameterizationState = { nextVariable: 1 };

    expect(parameterizeArgs("browser_navigate", {
      url: "https://example.test/orders/42",
    }, state)).toEqual({
      args: { url: "https://example.test/orders/42" },
      requiredVariables: [],
    });
    expect(state.nextVariable).toBe(1);
  });

  it("default-denies an unclassified string path for every recordable action", () => {
    for (const [action, metadata] of Object.entries(TOOL_METADATA)) {
      if (!metadata.recordable) continue;
      expect(() => parameterizeArgs(action as keyof typeof TOOL_METADATA, {
        unclassified: `SECRET_METADATA_DRIFT_${action}`,
      }, { nextVariable: 1 }), action).toThrow("RECORDING_METADATA_MISMATCH");
      expect(() => parameterizeArgs(action as keyof typeof TOOL_METADATA, {
        [`SECRET_METADATA_KEY_${action}`]: 1,
      }, { nextVariable: 1 }), action).toThrow("RECORDING_METADATA_MISMATCH");
    }
  });

  it("documents the accepted URL residual and full-URL sensitivity boundary", () => {
    const state: ParameterizationState = { nextVariable: 1 };
    const ordinary = "https://example.test/accounts/42";
    expect(parameterizeArgs("browser_navigate", { url: ordinary }, state).args.url).toBe(ordinary);

    for (const url of [
      "https://user:pass@example.test/accounts/42",
      "https://example.test/accounts/42?token=private",
      "https://example.test/accounts/42#private",
    ]) {
      const result = parameterizeArgs("browser_navigate", { url }, state);
      expect(result.args.url).toMatch(/^\{\{navigation_\d+\}\}$/);
      expect(JSON.stringify(result)).not.toContain(url);
    }
  });

  it("parameterizes every explicit non-HTTP(S) navigation scheme", () => {
    const state: ParameterizationState = { nextVariable: 1 };
    const urls = [
      "chrome://settings/passwords",
      "about:blank",
      "file:///tmp/SECRET_FILE_URL_4421",
      "data:text/plain,SECRET_DATA_URL_5318",
      "javascript:alert('SECRET_JS_URL_6209')",
      "custom-scheme://host/SECRET_CUSTOM_URL_7190",
    ];

    for (const url of urls) {
      const result = parameterizeArgs("browser_navigate", { url }, state);
      expect(result.args.url).toMatch(/^\{\{navigation_\d+\}\}$/);
      expect(JSON.stringify(result)).not.toContain(url);
    }
    expect(state.nextVariable).toBe(7);
  });
});

describe("sanitizePageUrl", () => {
  it("captures only origin and pathname and bounds commit metadata", () => {
    expect(sanitizePageUrl(
      `https://user:pass@example.test/orders/42?token=${SECRET_NAVIGATION}#receipt`,
    )).toBe("https://example.test/orders/42");
    expectAbsent(sanitizePageUrl(
      `https://user:pass@example.test/orders/42?token=${SECRET_NAVIGATION}#receipt`,
    ), [SECRET_NAVIGATION, "user", "pass", "receipt"]);
  });

  it("keeps only valid HTTP(S) origin plus pathname and empties passive non-web metadata", () => {
    expect(sanitizePageUrl("http://example.test/plain/path?private=1#fragment"))
      .toBe("http://example.test/plain/path");
    expect(sanitizePageUrl("https://example.test/secure/path"))
      .toBe("https://example.test/secure/path");
    for (const url of [
      "chrome://settings/passwords",
      "about:blank",
      "file:///tmp/SECRET_CAPTURE_FILE_8214",
      "data:text/plain,SECRET_CAPTURE_DATA_9305",
      "javascript:alert('SECRET_CAPTURE_JS_1046')",
      "custom-scheme://host/SECRET_CAPTURE_CUSTOM_2157",
    ]) {
      expect(sanitizePageUrl(url), url).toBe("");
    }
  });
});
