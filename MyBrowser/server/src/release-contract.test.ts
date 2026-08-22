import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { VERSION } from "./version";

type PackageContract = {
  version: string;
  files?: string[];
  scripts: Record<string, string>;
};

const readJson = (url: URL): PackageContract => JSON.parse(readFileSync(url, "utf8"));

describe("release package contract", () => {
  it("keeps paired runtime metadata and mandatory pack hooks aligned", () => {
    const serverPackage = readJson(new URL("../package.json", import.meta.url));
    const extensionPackage = readJson(new URL("../../extension/package.json", import.meta.url));
    const extensionConfig = readFileSync(
      new URL("../../extension/wxt.config.ts", import.meta.url),
      "utf8",
    );

    expect(VERSION).toBe("1.1.7");
    expect(serverPackage.version).toBe(VERSION);
    expect(extensionPackage.version).toBe(VERSION);
    expect(extensionConfig).toContain(`version: '${VERSION}'`);
    expect(serverPackage.files).toEqual(["dist"]);
    expect(serverPackage.scripts.prepack).toBe(
      "npm run clean && npm run check && npm test && npm run build",
    );
    expect(serverPackage.scripts.clean).toContain("rmSync('dist'");
    expect(serverPackage.scripts.build).toContain("chmodSync('dist/index.js'");
  });

  it("publishes the browser routing and temporary-tab operating contract", () => {
    const browserTools = readFileSync(new URL("./tools/browser.ts", import.meta.url), "utf8");
    const tabTools = readFileSync(new URL("./tools/tabs.ts", import.meta.url), "utf8");

    expect(browserTools).toContain("only when the user explicitly requests another browser");
    expect(tabTools).toContain("temporary tab by default");
    expect(tabTools).toContain("including failure paths");
  });

  it("publishes a safe low-friction agent installation handoff", () => {
    const instructions = readFileSync(new URL("../../../llms.txt", import.meta.url), "utf8");
    const projectMcp = readFileSync(new URL("../../.mcp.json", import.meta.url), "utf8");

    expect(instructions).toContain("npx -y @alessai/mybrowser-mcp");
    expect(instructions).toContain("no CMD installer");
    expect(instructions).toContain("no popup settings");
    expect(instructions).toContain("Load unpacked");
    expect(instructions).toContain("never display that token");
    expect(instructions).toContain("do not force-kill Chrome");
    expect(instructions).toContain("browser_diagnostics");
    expect(projectMcp).toContain("${CLAUDE_PROJECT_DIR}/server/dist/index.js");
    expect(projectMcp).not.toContain("/mnt/");
  });
});
