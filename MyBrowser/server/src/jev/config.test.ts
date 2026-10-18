import { describe, expect, it } from "vitest";
import { validateConfigOverrides } from "../auth.js";
import { readJevConfig } from "./config.js";

describe("jev config", () => {
  it("is off when the section is absent", () => {
    expect(readJevConfig(undefined)).toBeUndefined();
  });

  it("applies measured defaults", () => {
    expect(readJevConfig({ apiKey: " apikey_x " })).toEqual({
      apiKey: "apikey_x", vision: false, minConfidence: 0.7, timeoutMs: 3000,
    });
  });

  it.each([
    [null, /expected an object/],
    [{}, /apiKey/],
    [{ apiKey: "" }, /apiKey/],
    [{ apiKey: "k", vision: "yes" }, /vision/],
    [{ apiKey: "k", minConfidence: 0.3 }, /minConfidence/],
    [{ apiKey: "k", minConfidence: 1 }, /minConfidence/],
    [{ apiKey: "k", timeoutMs: 100 }, /timeoutMs/],
    [{ apiKey: "k", timeoutMs: 1500.5 }, /timeoutMs/],
    [{ apiKey: "k", model: "jev-latest" }, /unknown key "model"/],
  ])("rejects %j", (raw, message) => {
    expect(() => readJevConfig(raw)).toThrow(message);
  });

  it("fails closed at startup through config validation", () => {
    expect(() => validateConfigOverrides({ jev: { apiKey: "" } })).toThrow(/apiKey/);
    expect(() => validateConfigOverrides({ jev: { apiKey: "k" } })).not.toThrow();
  });
});
