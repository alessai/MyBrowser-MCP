import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "./types.js";

const UploadArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses the active tab."),
  selector: z.string().describe("CSS selector for the <input type='file'> element"),
  files: z.array(z.string()).describe("Array of absolute file paths to upload (e.g. ['/home/user/photo.jpg', '/tmp/video.mp4'])"),
});

export const upload: Tool = {
  schema: {
    name: "browser_upload",
    description: "Upload files to a <input type='file'> element. Provide the CSS selector for the file input and an array of absolute file paths. Works for photos, videos, documents — essential for posting to social media (TikTok, Instagram, Twitter).",
    inputSchema: zodToJsonSchema(UploadArgs),
  },
  handle: async (context, params) => {
    const { tabId, selector, files } = UploadArgs.parse(params);
    const payload = { tabId, selector, files };
    await context.sendSocketMessage("browser_upload", payload);
    return {
      content: [
        { type: "text" as const, text: `Uploaded ${files.length} file(s) to ${selector}: ${files.join(", ")}` },
      ],
    };
  },
};
