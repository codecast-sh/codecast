import { describe, expect, test } from "bun:test";
import { tabFooterLines, TAB_AFFECTING_VERBS } from "./tabFooter.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("tabFooterLines", () => {
  test("prints the active tab's URL then its 8-char target id", () => {
    const lines = tabFooterLines([
      { targetId: "AAAAAAAA11111111222222223333333", url: "https://a.example", active: false },
      { targetId: "4F2F46289BE9FEF4C1DD358BF3A9E7F2", url: "https://example.com/?x=1", active: true },
    ]).map(strip);
    expect(lines).toEqual(["  https://example.com/?x=1", "  tab 4F2F4628"]);
  });

  test("falls back to the first tab when none is marked active", () => {
    const lines = tabFooterLines([{ targetId: "4F2F46289BE9FEF4C1DD358BF3A9E7F2", url: "about:blank" }]).map(strip);
    expect(lines).toEqual(["  tab 4F2F4628"]);
  });

  test("nothing to name prints nothing", () => {
    expect(tabFooterLines([])).toEqual([]);
    expect(tabFooterLines([{ targetId: "" }])).toEqual([]);
  });

  test("read-only verbs get no footer", () => {
    expect(TAB_AFFECTING_VERBS.has("open")).toBe(true);
    expect(TAB_AFFECTING_VERBS.has("snapshot")).toBe(false);
    expect(TAB_AFFECTING_VERBS.has("read")).toBe(false);
  });
});
