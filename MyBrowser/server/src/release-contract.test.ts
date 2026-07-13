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

    expect(VERSION).toBe("1.1.5");
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
});
