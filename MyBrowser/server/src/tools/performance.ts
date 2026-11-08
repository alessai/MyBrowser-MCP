import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "./types.js";

const TabIdParam = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses this session's current tab (opened with new_tab or browser_navigate, or chosen with select_tab), never the user's active tab."),
});

const PerformanceArgs = TabIdParam.extend({
  action: z.enum(["get_metrics", "get_web_vitals"]).describe(
    "get_metrics: retrieve CDP Performance.getMetrics data. get_web_vitals: evaluate JS to get Core Web Vitals (LCP, FID, CLS)."
  ),
});

export const performance: Tool = {
  schema: {
    name: "browser_performance",
    description:
      "Inspect page performance. get_metrics returns Chrome DevTools Performance domain metrics (JSHeapUsedSize, Nodes, etc). get_web_vitals returns Core Web Vitals (LCP, FID, CLS) from the page.",
    inputSchema: zodToJsonSchema(PerformanceArgs),
  },
  handle: async (context, params) => {
    const args = PerformanceArgs.parse(params ?? {});
    const { tabId, ...rest } = args;
    const payload = tabId !== undefined ? { tabId, ...rest } : { ...rest };
    const result = await context.sendSocketMessage("browser_performance", payload);
    return {
      content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
    };
  },
};
