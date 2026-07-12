import { describe, expect, it } from "vitest";

import { getRegisteredToolNames } from "./tools";
import { TOOL_METADATA } from "./tool-metadata";

describe("TOOL_METADATA", () => {
  it("classifies every registered tool exactly once", () => {
    expect(Object.keys(TOOL_METADATA).sort()).toEqual(getRegisteredToolNames().sort());

    for (const metadata of Object.values(TOOL_METADATA)) {
      expect(Object.keys(metadata).sort()).toEqual([
        "mutatesTab",
        "queue",
        "recordable",
        "tab",
      ]);
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
    expect(TOOL_METADATA.browser_replay.queue).toBe("tab");
  });

  it("preserves current recorder eligibility", () => {
    const recordable = Object.entries(TOOL_METADATA)
      .filter(([, metadata]) => metadata.recordable)
      .map(([name]) => name)
      .sort();

    expect(recordable).toEqual([
      "browser_click",
      "browser_drag",
      "browser_fill_form",
      "browser_go_back",
      "browser_go_forward",
      "browser_hover",
      "browser_navigate",
      "browser_press_key",
      "browser_reset_viewport",
      "browser_select_option",
      "browser_set_viewport",
      "browser_type",
      "browser_wait",
      "browser_wait_for",
      "close_tab",
      "new_tab",
      "select_tab",
    ]);
    expect(TOOL_METADATA.browser_wait.tab).toBe("optional");
  });

  it("routes global mutations through the global queue", () => {
    expect(TOOL_METADATA.new_tab).toMatchObject({ tab: "none", queue: "global" });
    expect(TOOL_METADATA.browser_network.queue).toBe("global");
    expect(TOOL_METADATA.browser_register_handler.queue).toBe("global");
    expect(TOOL_METADATA.browser_unregister_handler.queue).toBe("global");
  });
});
