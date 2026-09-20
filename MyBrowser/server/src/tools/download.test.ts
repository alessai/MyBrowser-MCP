import { describe, expect, it, vi } from "vitest";

import type { Context } from "../context.js";
import { download } from "./download.js";

describe("browser_download", () => {
  it("passes args through to the extension unchanged", async () => {
    const context = {
      sendSocketMessage: vi.fn(async () => ({ downloadId: 1, filename: "/tmp/report.pdf" })),
    } as unknown as Context;

    await download.handle(context, {
      tabId: 42,
      url: "https://example.com/report.pdf",
      filename: "report.pdf",
      directory: "reports/2026",
    });

    expect(context.sendSocketMessage).toHaveBeenCalledTimes(1);
    expect(context.sendSocketMessage).toHaveBeenCalledWith("browser_download", {
      tabId: 42,
      url: "https://example.com/report.pdf",
      filename: "report.pdf",
      directory: "reports/2026",
    });
  });

  it("tells the truth about where the file lands", () => {
    expect(download.schema.description).toContain("BROWSER's machine");
    expect(download.schema.description).toContain("does NOT land on the MCP server");
    expect(download.schema.description).toContain("browser_fetch_file");
    expect(download.schema.description).toContain("downloads folder");
  });
});
