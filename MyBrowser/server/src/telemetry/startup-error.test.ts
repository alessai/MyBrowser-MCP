import { describe, expect, it } from "vitest";

import { formatStartupFailure } from "./startup-error.js";

describe("formatStartupFailure", () => {
  it("normalizes controls and bounds UTF-8 output", () => {
    const formatted = formatStartupFailure(
      new Error(`bad\nsecret\0\u009b${"🙂".repeat(1_000)}`),
    );

    expect(formatted).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    expect(Buffer.byteLength(formatted, "utf8")).toBeLessThanOrEqual(512);
    expect(formatted).toContain("bad secret");
  });

  it("does not stringify arbitrary thrown values", () => {
    expect(formatStartupFailure({ secret: "RAW_SECRET" })).toBe("Unknown startup failure");
  });

  it("does not throw when error inspection is hostile", () => {
    const hostile = new Proxy(new Error("RAW_SECRET"), {
      getOwnPropertyDescriptor: () => {
        throw new Error("descriptor trap");
      },
    });

    expect(() => formatStartupFailure(hostile)).not.toThrow();
    expect(formatStartupFailure(hostile)).toBe("Unknown startup failure");
  });
});
