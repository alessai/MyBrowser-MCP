import { describe, expect, it, vi } from "vitest";
import type { Context } from "../context.js";
import { readPageState, SAFE_HREF_JS, VALUE_NAME_JS, VERIFY_MARKER, verifyElement } from "./page.js";

// The helpers run in the page; evaluate their source the same way here.
const safeHref = new Function(`return ${SAFE_HREF_JS}`)() as (href: string, base: string) => string;
const valueName = new Function(`return ${VALUE_NAME_JS}`)() as (el: { tagName: string; type?: string; value?: string }) => string;

describe("what the page read sends to TypeSafe", () => {
  const base = "https://news.ycombinator.com/news";

  it("keeps the path and query keys of a link but drops query values and fragments", () => {
    expect(safeHref("item?id=50141681#c3", base)).toBe("/item?id=\u2026");
    expect(safeHref("https://app.example.com/reset?token=s3cr3t&email=a%40b.c", base)).toBe("app.example.com/reset?token=\u2026&email=\u2026");
  });

  it("masks opaque tokens in link paths", () => {
    expect(safeHref("/auth/magic/aB3dE5fG7hJ9kL1mN3pQ5rS7", base)).toBe("/auth/magic/\u2026");
    expect(safeHref("/alessai/MyBrowser-MCP/issues", base)).toBe("/alessai/MyBrowser-MCP/issues");
  });

  it("drops non-web links", () => {
    expect(safeHref("javascript:alert(1)", base)).toBe("");
    expect(safeHref("mailto:a@b.c", base)).toBe("");
  });

  it("never uses a typed field value as an element name", () => {
    expect(valueName({ tagName: "INPUT", type: "password", value: "hunter2" })).toBe("");
    expect(valueName({ tagName: "INPUT", type: "text", value: "saif@example.com" })).toBe("");
    expect(valueName({ tagName: "INPUT", type: "submit", value: "Log in" })).toBe("Log in");
  });

  it("generates page-read and verify scripts that parse", async () => {
    const codes: string[] = [];
    const sendSocketMessage = vi.fn(async (_kind: string, payload: { code: string }) => {
      codes.push(payload.code);
      return payload.code.startsWith(VERIFY_MARKER) ? { value: { ok: true } } : { value: { url: "", title: "", elements: [] } };
    });
    const context = { sendSocketMessage } as unknown as Context;
    await readPageState(context, 1, { includeText: true });
    await verifyElement(context, 1, "/x", { role: "button", name: 'Say "hi"', region: "", href: "", selector: "a > b", near: "row" }, 1000);
    for (const code of codes) expect(() => new Function(code)).not.toThrow();
  });

  it("reports why a re-check failed", async () => {
    const sendSocketMessage = vi.fn(async () => ({ value: { ok: false, reason: "the page URL changed" } }));
    const result = await verifyElement({ sendSocketMessage } as unknown as Context, undefined, "/x",
      { role: "button", name: "Go", region: "", href: "", selector: "#go" }, 1000);
    expect(result).toEqual({ ok: false, reason: "the page URL changed" });
  });
});
