import { randomUUID } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Context } from "../context.js";
import type { Tool } from "./types.js";

const UPLOAD_TRANSFER_TIMEOUT_MS = 300_000;

const UploadArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses the active tab."),
  selector: z.string().describe("CSS selector for the <input type='file'> element"),
  files: z.array(z.string()).optional().describe("Array of absolute file paths that must exist on the BROWSER's machine (where Chrome runs) — attached via the Chrome debugger (e.g. ['/home/user/photo.jpg', '/tmp/video.mp4'])."),
  localFiles: z.array(z.string()).optional().describe("Array of absolute file paths that must exist on the MCP SERVER machine — the bytes are streamed to the browser in memory (nothing is written to the browser's disk). Each file is size-capped by the transfers.maxFileMb config (default 40 MB)."),
}).superRefine((value, refineCtx) => {
  const hasFiles = value.files !== undefined;
  const hasLocalFiles = value.localFiles !== undefined;
  if (hasFiles === hasLocalFiles) {
    refineCtx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide exactly one of `files` (paths on the browser's machine) or `localFiles` (paths on the MCP server machine), never both and never neither.",
      path: [hasFiles ? "files" : "localFiles"],
    });
  }
});

// Cross-agent stub: Context.startUploadTransfer is Agent 1's completion in
// context.ts. Declared here so this file compiles before that lands; the
// optional-property cast keeps tsc green either way.
type UploadTransferFile = { path: string; filename: string; mimeType: string };
type StartUploadTransfer = (
  requestId: string,
  files: UploadTransferFile[],
  target: { tabId?: number; selector: string },
  options?: { timeoutMs?: number },
) => Promise<{ files: Array<{ name: string; size: number; sha256: string }>; landedPath?: never }>;

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  zip: "application/zip",
  gz: "application/gzip",
};

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function inferMimeType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export const upload: Tool = {
  schema: {
    name: "browser_upload",
    description: "Upload files to a <input type='file'> element. Provide the CSS selector for the file input plus `files` (array of absolute paths that must exist on the BROWSER's machine — the machine running Chrome — attached via the Chrome debugger) OR `localFiles` (array of absolute paths on the MCP SERVER machine, streamed to the browser in memory without touching the browser's disk; each file capped at 40 MB by default via transfers.maxFileMb) — provide exactly one of the two. Works for photos, videos, documents — essential for posting to social media (TikTok, Instagram, Twitter).",
    inputSchema: zodToJsonSchema(UploadArgs),
  },
  handle: async (context, params) => {
    const { tabId, selector, files, localFiles } = UploadArgs.parse(params);

    if (localFiles) {
      const startUploadTransfer = (context as Context & {
        startUploadTransfer?: StartUploadTransfer;
      }).startUploadTransfer;
      if (!startUploadTransfer) {
        throw new Error("browser_upload localFiles requires server transfer support (startUploadTransfer is unavailable in this build).");
      }
      const transferRequestId = randomUUID();
      const transferFiles = localFiles.map((path) => ({
        path,
        filename: basename(path),
        mimeType: inferMimeType(path),
      }));

      // Start the browser_upload tool request first so the extension's
      // localFiles driver engages and waits for the transfers; it resolves
      // when the content script commits every file into the input.
      const socketPromise = context
        .sendSocketMessage(
          "browser_upload",
          {
            ...(tabId !== undefined ? { tabId } : {}),
            selector,
            localFiles: transferFiles.map((file) => file.filename),
            transferRequestId,
          },
          { timeoutMs: UPLOAD_TRANSFER_TIMEOUT_MS },
        )
        .catch((error: unknown) => {
          throw error instanceof Error ? error : new Error(String(error));
        });

      await withTimeout(
        startUploadTransfer.call(
          context,
          transferRequestId,
          transferFiles,
          { tabId, selector },
          { timeoutMs: UPLOAD_TRANSFER_TIMEOUT_MS },
        ),
        UPLOAD_TRANSFER_TIMEOUT_MS,
        `UPLOAD_TRANSFER_TIMEOUT: file transfer to the browser did not complete within ${UPLOAD_TRANSFER_TIMEOUT_MS} ms`,
      );

      const response = await withTimeout(
        socketPromise,
        UPLOAD_TRANSFER_TIMEOUT_MS,
        `UPLOAD_RESPONSE_TIMEOUT: bytes reached the browser but the upload was not confirmed within ${UPLOAD_TRANSFER_TIMEOUT_MS} ms`,
      ) as { uploaded?: boolean; files?: Array<{ name: string; size: number }>; error?: string };
      if (typeof response?.error === "string" && response.error.length > 0) {
        throw new Error(response.error);
      }
      const uploadedFiles = response?.files ?? [];
      return {
        content: [
          { type: "text" as const, text: `Uploaded ${uploadedFiles.length} file(s) to ${selector} on the browser: ${uploadedFiles.map((file) => file.name).join(", ")}` },
        ],
      };
    }

    const requestedFiles = files ?? [];
    await context.sendSocketMessage("browser_upload", { tabId, selector, files: requestedFiles });
    return {
      content: [
        { type: "text" as const, text: `Uploaded ${requestedFiles.length} file(s) to ${selector}: ${requestedFiles.join(", ")}` },
      ],
    };
  },
};
