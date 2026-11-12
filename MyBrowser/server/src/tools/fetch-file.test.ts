import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { Context } from "../context.js";
import { resolveBrowserPayloadUrls } from "../local-url.js";
import { fetchFile } from "./fetch-file.js";

function createContext(result: unknown = { landedPath: "/tmp/transfers/downloads/s1/report.pdf" }) {
  const sendSocketMessage = vi.fn(
    async (_type: string, _payload?: unknown, _options?: { timeoutMs: number }) => result,
  );
  const context = { sendSocketMessage } as unknown as Context & {
    sendSocketMessage: typeof sendSocketMessage;
  };
  return { context, sendSocketMessage };
}

describe("browser_fetch_file", () => {
  it("rejects a non-URL without contacting the browser", async () => {
    const { context } = createContext();
    await expect(fetchFile.handle(context, { url: "not a url" })).rejects.toThrow();
    await expect(fetchFile.handle(context, {})).rejects.toThrow();
    expect(context.sendSocketMessage).not.toHaveBeenCalled();
  });

  it("mints a transferId and sends url, filename, transferId with the long timeout", async () => {
    const { context } = createContext();
    await fetchFile.handle(context, { url: "https://example.com/files/Quarterly Report.pdf" });

    expect(context.sendSocketMessage).toHaveBeenCalledTimes(1);
    const [type, payload, options] = context.sendSocketMessage.mock.calls[0]!;
    expect(type).toBe("browser_fetch_file");
    expect(options).toEqual({ timeoutMs: 300_000 });
    expect(payload).toMatchObject({
      url: "https://example.com/files/Quarterly Report.pdf",
      filename: "Quarterly_Report.pdf",
    });
    const transferId = (payload as { transferId: string }).transferId;
    expect(transferId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("sanitizes an explicit filename and mints a fresh transferId per call", async () => {
    const { context } = createContext();
    await fetchFile.handle(context, { url: "https://example.com/x.bin", filename: "my file (1).pdf" });
    await fetchFile.handle(context, { url: "https://example.com/x.bin", filename: "other.bin" });

    const first = context.sendSocketMessage.mock.calls[0]![1] as { filename: string; transferId: string };
    const second = context.sendSocketMessage.mock.calls[1]![1] as { filename: string; transferId: string };
    expect(first.filename).toBe("my_file_1_.pdf");
    expect(second.filename).toBe("other.bin");
    expect(first.transferId).not.toBe(second.transferId);
  });

  it("falls back to a safe name when the URL has no filename", async () => {
    const { context } = createContext();
    await fetchFile.handle(context, { url: "https://example.com/" });

    const payload = context.sendSocketMessage.mock.calls[0]![1] as { filename: string };
    expect(payload.filename).toBe("download");
  });

  it("reports the landing path without dumping raw bytes into the chat", async () => {
    const { context } = createContext({
      landedPath: "/tmp/transfers/downloads/s1/report.pdf",
      filename: "report.pdf",
      sha256: "abc123",
      mimeType: "application/pdf",
      bytes: "QUJD",
    });
    const result = await fetchFile.handle(context, { url: "https://example.com/report.pdf" });
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain("/tmp/transfers/downloads/s1/report.pdf");
    expect(text).toContain("abc123");
    expect(text).not.toContain("QUJD");
  });

  it("rewrites loopback URLs to the canonical device host like other URL tools", () => {
    const rewritten = resolveBrowserPayloadUrls(
      "browser_fetch_file",
      { url: "http://localhost:4173/app.zip", transferId: "t1" },
      "100.95.83.128",
    ) as { url: string };
    expect(rewritten.url).toBe("http://100.95.83.128:4173/app.zip");

    const untouched = resolveBrowserPayloadUrls(
      "browser_fetch_file",
      { url: "https://example.com/app.zip", transferId: "t1" },
      "100.95.83.128",
    ) as { url: string };
    expect(untouched.url).toBe("https://example.com/app.zip");
  });

  it("inline returns a small text body; urls fetches several, two at a time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-fetch-"));
    const json = join(dir, "a.json");
    writeFileSync(json, '{"ok":true}');
    const { context, sendSocketMessage } = createContext({ landedPath: json, mimeType: "application/json", sha256: "ff" });
    const one = await fetchFile.handle(context, { url: "https://example.com/a.json", inline: true });
    expect((one.content[0] as { text: string }).text).toContain('Body:\n{"ok":true}');

    let active = 0;
    let peak = 0;
    sendSocketMessage.mockImplementation(async (_t: string, payload?: unknown) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      if (String((payload as { url: string }).url).endsWith("/bad")) throw new Error("HTTP 404");
      return { landedPath: json, mimeType: "application/json", sha256: "ff" };
    });
    const many = await fetchFile.handle(context, { urls: ["https://e.test/1", "https://e.test/bad", "https://e.test/3", "https://e.test/4"] });
    const text = (many.content[0] as { text: string }).text;
    expect(text).toMatch(/^Fetched 3 of 4 URLs\./);
    expect(text).toContain("2. FAILED https://e.test/bad: HTTP 404");
    expect(peak).toBe(2);
    await expect(fetchFile.handle(context, { url: "https://e.test/1", urls: ["https://e.test/2"] })).rejects.toThrow();
  });

  it("tells the truth about direction, landing location, and size", () => {
    expect(fetchFile.schema.description).toContain("THROUGH the selected browser");
    expect(fetchFile.schema.description).toContain("cookies");
    expect(fetchFile.schema.description).toContain("~/.mybrowser/transfers/downloads/");
    expect(fetchFile.schema.description).toContain("MCP server machine");
    expect(fetchFile.schema.description).toContain("browser_download");
  });
});
