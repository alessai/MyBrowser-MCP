import { describe, expect, it, vi } from "vitest";

import type { Context } from "../context.js";
import { upload } from "./upload.js";

function createContextWithTransfers() {
  const startUploadTransfer = vi.fn(
    async (
      _requestId: string,
      _files?: Array<{ path: string; filename: string; mimeType: string }>,
      _target?: { tabId?: number; selector: string },
    ) => ({
      files: [{ name: "Holiday Photo.JPG", size: 12_345, sha256: "deadbeef" }],
    }),
  );
  const sendSocketMessage = vi.fn(async () => ({
    uploaded: true,
    files: [{ name: "Holiday Photo.JPG", size: 12_345 }],
  }));
  return {
    startUploadTransfer,
    sendSocketMessage,
    context: { startUploadTransfer, sendSocketMessage } as unknown as Context & {
      startUploadTransfer: ReturnType<typeof vi.fn>;
      sendSocketMessage: ReturnType<typeof vi.fn>;
    },
  };
}

describe("browser_upload", () => {
  it("rejects when both files and localFiles are provided", async () => {
    const { context } = createContextWithTransfers();
    await expect(
      upload.handle(context, {
        selector: "#file",
        files: ["/tmp/a.jpg"],
        localFiles: ["/tmp/a.jpg"],
      }),
    ).rejects.toThrow(/exactly one of `files`[\s\S]*`localFiles`/);
    expect(context.startUploadTransfer).not.toHaveBeenCalled();
    expect(context.sendSocketMessage).not.toHaveBeenCalled();
  });

  it("rejects when neither files nor localFiles is provided", async () => {
    const { context } = createContextWithTransfers();
    await expect(upload.handle(context, { selector: "#file" })).rejects.toThrow(
      /exactly one of `files`[\s\S]*`localFiles`/,
    );
  });

  it("keeps browser-local files mode on the socket path unchanged", async () => {
    const context = {
      sendSocketMessage: vi.fn(async () => undefined),
    } as unknown as Context & { sendSocketMessage: ReturnType<typeof vi.fn> };

    await upload.handle(context, { selector: "#file", files: ["/home/user/photo.jpg"] });

    expect(context.sendSocketMessage).toHaveBeenCalledWith("browser_upload", {
      tabId: undefined,
      selector: "#file",
      files: ["/home/user/photo.jpg"],
    });
  });

  it("streams localFiles through startUploadTransfer with sanitized names and inferred mime types", async () => {
    const { context, startUploadTransfer } = createContextWithTransfers();

    await upload.handle(context, {
      selector: "input[type=file]",
      localFiles: ["/srv/incoming/Holiday Photo.JPG", "/srv/incoming/notes.txt"],
    });

    expect(startUploadTransfer).toHaveBeenCalledTimes(1);
    const [requestId, files, target] = startUploadTransfer.mock.calls[0]!;
    expect(typeof requestId).toBe("string");
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(files).toEqual([
      { path: "/srv/incoming/Holiday Photo.JPG", filename: "Holiday Photo.JPG", mimeType: "image/jpeg" },
      { path: "/srv/incoming/notes.txt", filename: "notes.txt", mimeType: "text/plain" },
    ]);
    expect(target).toEqual({ tabId: undefined, selector: "input[type=file]" });
  });

  it("reports the committed file names from the transfer result", async () => {
    const { context, sendSocketMessage, startUploadTransfer } = createContextWithTransfers();
    const result = await upload.handle(context, { selector: "#file", localFiles: ["/srv/photo.jpg"] });
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain("Uploaded 1 file(s) to #file");
    expect(text).toContain("Holiday Photo.JPG");
    // The tool request must carry the same correlation id the transfers use.
    const socketCall = sendSocketMessage.mock.calls[0] as unknown as unknown[];
    const transferCall = startUploadTransfer.mock.calls[0] as unknown as unknown[];
    const socketPayload = socketCall[1] as { transferRequestId?: string };
    expect(socketPayload.transferRequestId).toBe(transferCall[0]);
  });

  it("tells the truth about where paths resolve and the size cap", () => {
    expect(upload.schema.description).toContain("exactly one of the two");
    expect(upload.schema.description).toContain("BROWSER's machine");
    expect(upload.schema.description).toContain("Chrome debugger");
    expect(upload.schema.description).toContain("MCP SERVER machine");
    expect(upload.schema.description).toContain("in memory");
    expect(upload.schema.description).toContain("40 MB");
  });
});
