import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "./types.js";

const DownloadArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses the active tab."),
  url: z.string().optional().describe("URL to download. If omitted, downloads the current page."),
  filename: z.string().optional().describe("Save as filename (e.g. 'photo.jpg'). If omitted, uses the URL filename."),
  directory: z.string().optional().describe("Subdirectory under the browser's default downloads folder. If omitted, saves to the default location."),
});

export const download: Tool = {
  schema: {
    name: "browser_download",
    description: "Download a file from a URL using the browser's built-in download manager. Optionally save it into a subdirectory under the default downloads folder.",
    inputSchema: zodToJsonSchema(DownloadArgs),
  },
  handle: async (context, params) => {
    const args = DownloadArgs.parse(params);
    const payload = { ...args };
    const result = await context.sendSocketMessage("browser_download", payload);
    return {
      content: [
        { type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result, null, 2) },
      ],
    };
  },
};
