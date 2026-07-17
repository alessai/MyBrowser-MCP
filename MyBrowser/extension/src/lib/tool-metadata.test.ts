import { describe, expect, it } from "vitest";

import { getRegisteredToolNames } from "./tools";
import {
  RECORDING_ARGUMENT_TYPES,
  RECORDING_NUMERIC_BOUNDS,
  TOOL_TELEMETRY_STATE_SIGNALS,
  TOOL_METADATA,
} from "./tool-metadata";

describe("TOOL_METADATA", () => {
  it("declares only state changes already guaranteed by successful tool execution", () => {
    expect(TOOL_TELEMETRY_STATE_SIGNALS).toEqual({
      close_tab: ["tabChanged"],
      new_tab: ["tabChanged"],
    });
    for (const [toolName, signals] of Object.entries(TOOL_TELEMETRY_STATE_SIGNALS)) {
      expect(toolName in TOOL_METADATA).toBe(true);
      expect(signals.every((signal) => [
        "tabChanged",
        "originChanged",
        "pathChanged",
        "loadStatusChanged",
      ].includes(signal))).toBe(true);
    }
  });

  it("classifies every registered tool exactly once", () => {
    expect(Object.keys(TOOL_METADATA).sort()).toEqual(getRegisteredToolNames().sort());

    for (const metadata of Object.values(TOOL_METADATA)) {
      const expectedKeys = [
        "mutatesTab",
        "queue",
        "recordable",
        "tab",
      ];
      if (metadata.recordable) expectedKeys.push("recordingStrings");
      expect(Object.keys(metadata).sort()).toEqual(expectedKeys.sort());
    }
  });

  it("uses the required recording-control queues", () => {
    expect(TOOL_METADATA.browser_record_start).toEqual({
      tab: "required",
      queue: "session",
      mutatesTab: false,
      recordable: false,
    });
    expect(TOOL_METADATA.browser_record_stop).toEqual({
      tab: "none",
      queue: "session",
      mutatesTab: false,
      recordable: false,
    });
    expect(TOOL_METADATA.browser_replay).toEqual({
      tab: "required",
      queue: "tab",
      mutatesTab: true,
      recordable: false,
    });
  });

  it("defines exhaustive string metadata for every recordable tool", () => {
    const recordable = Object.entries(TOOL_METADATA)
      .filter(([, metadata]) => metadata.recordable)
      .map(([name, metadata]) => [name, "recordingStrings" in metadata ? metadata.recordingStrings : undefined])
      .sort();

    expect(recordable).toEqual([
      ["browser_assert", {
        "checks.*.selector": "safe", "checks.*.type": "safe", "checks.*.value": "text",
      }],
      ["browser_click", {
        element: "safe", label: "safe", matchText: "safe", name: "safe",
        ref: "safe", role: "safe", selector: "safe",
      }],
      ["browser_clipboard", { action: "safe", text: "clipboard" }],
      ["browser_drag", {
        endElement: "safe", endRef: "safe", endSelector: "safe",
        startElement: "safe", startRef: "safe", startSelector: "safe",
      }],
      ["browser_fill_form", { "fields.*": "form", submitText: "safe" }],
      ["browser_go_back", {}],
      ["browser_go_forward", {}],
      ["browser_hover", {
        element: "safe", label: "safe", matchText: "safe", name: "safe",
        ref: "safe", role: "safe", selector: "safe",
      }],
      ["browser_navigate", { url: "navigation" }],
      ["browser_press_key", { key: "safe" }],
      ["browser_reset_viewport", {}],
      ["browser_select_option", {
        element: "safe", label: "safe", matchText: "safe", name: "safe",
        ref: "safe", role: "safe", selector: "safe", "values.*": "select",
      }],
      ["browser_set_viewport", { orientation: "safe", preset: "safe" }],
      ["browser_type", {
        element: "safe", label: "safe", matchText: "safe", name: "safe",
        ref: "safe", role: "safe", selector: "safe", text: "text",
      }],
      ["browser_wait", {}],
      ["browser_wait_for", { condition: "safe", selector: "safe", value: "text" }],
    ]);
    expect(TOOL_METADATA.new_tab.recordable).toBe(false);
    expect(TOOL_METADATA.select_tab.recordable).toBe(false);
    expect(TOOL_METADATA.close_tab.recordable).toBe(false);
    expect(TOOL_METADATA.browser_wait.tab).toBe("optional");
    expect(Object.keys(RECORDING_ARGUMENT_TYPES).sort())
      .toEqual(recordable.map(([name]) => name).sort());
    for (const [name, metadata] of recordable) {
      const stringMetadata = metadata as Readonly<Record<string, string>>;
      const types = RECORDING_ARGUMENT_TYPES[
        name as keyof typeof RECORDING_ARGUMENT_TYPES
      ] as Readonly<Record<string, string>>;
      expect(types[""]).toBe("object");
      for (const path of Object.keys(stringMetadata)) expect(types[path]).toBe("string");
      expect(Object.entries(types)
        .filter(([, type]) => type === "string")
        .map(([path]) => path)
        .sort()).toEqual(Object.keys(stringMetadata).sort());
      expect(Object.values(types).every((type) => [
        "array", "boolean", "number", "object", "string",
      ].includes(type))).toBe(true);
      const numericPaths = Object.entries(types)
        .filter(([, type]) => type === "number")
        .map(([path]) => path)
        .sort();
      const bounds = RECORDING_NUMERIC_BOUNDS[
        name as keyof typeof RECORDING_NUMERIC_BOUNDS
      ] as Readonly<Record<string, { integer: boolean; min: number; max: number }>>;
      expect(Object.keys(bounds).sort()).toEqual(numericPaths);
      for (const constraint of Object.values(bounds)) {
        expect(Object.keys(constraint).sort()).toEqual(["integer", "max", "min"]);
        expect(Number.isFinite(constraint.min)).toBe(true);
        expect(Number.isFinite(constraint.max)).toBe(true);
        expect(constraint.min).toBeLessThanOrEqual(constraint.max);
      }
    }
  });

  it("routes global mutations through the global queue", () => {
    expect(TOOL_METADATA.new_tab).toMatchObject({ tab: "none", queue: "global" });
    expect(TOOL_METADATA.browser_network.queue).toBe("global");
    expect(TOOL_METADATA.browser_register_handler.queue).toBe("global");
    expect(TOOL_METADATA.browser_unregister_handler.queue).toBe("global");
  });
});
