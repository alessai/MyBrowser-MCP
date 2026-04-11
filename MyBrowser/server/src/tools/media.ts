import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "./types.js";

const TabIdParam = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses the active tab."),
});

const ScreenshotArgs = TabIdParam.extend({
  annotate: z.boolean().optional().default(true)
    .describe("If true (default), overlay numbered markers on interactive elements and include a compact label map. Use mark numbers to click elements."),
});

const ConsoleLogsArgs = TabIdParam;

export const screenshot: Tool = {
  schema: {
    name: "browser_screenshot",
    description: "Take a screenshot of the current page. By default, annotates interactive elements with numbered markers. Use the marker numbers with browser_click({mark: N}) to interact. If this fails with a chrome-extension access error, close DevTools and retry with conflicting extensions disabled.",
    inputSchema: zodToJsonSchema(ScreenshotArgs),
  },
  handle: async (context, params) => {
    const { tabId, annotate } = ScreenshotArgs.parse(params ?? {});
    const payload = tabId !== undefined ? { tabId, annotate } : { annotate };

    if (annotate) {
      let labelMap = "";
      try {
        // Generate marks, take screenshot with overlay, get label map
        labelMap = await context.sendSocketMessage("generateMarks", payload);
        const data = await context.sendSocketMessage("browser_screenshot", payload);
        return {
          content: [
            {
              type: "image" as const,
              data,
              mimeType: "image/png",
            },
            {
              type: "text" as const,
              text: `Interactive elements:\n${labelMap}`,
            },
          ],
        };
      } finally {
        await context.sendSocketMessage("clearMarks", payload).catch(() => {});
      }
    }

    // Plain screenshot without annotations
    const data = await context.sendSocketMessage("browser_screenshot", payload);
    return {
      content: [
        {
          type: "image" as const,
          data,
          mimeType: "image/png",
        },
      ],
    };
  },
};

export const getConsoleLogs: Tool = {
  schema: {
    name: "browser_get_console_logs",
    description: "Get the console logs from the browser",
    inputSchema: zodToJsonSchema(ConsoleLogsArgs),
  },
  handle: async (context, params) => {
    const { tabId } = ConsoleLogsArgs.parse(params ?? {});
    const payload = tabId !== undefined ? { tabId } : {};
    const consoleLogs = await context.sendSocketMessage(
      "browser_get_console_logs",
      payload
    );
    const text = (consoleLogs as any[]).map((log: any) => JSON.stringify(log)).join("\n");
    return { content: [{ type: "text", text }] };
  },
};
