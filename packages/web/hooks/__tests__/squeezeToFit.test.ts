import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { squeezeStateFor, squeezeStep } from "../useSqueezeToFit";

// The conversation header is one row. It sheds chip detail step by step and
// lets the title truncate last, but it never grows a second line: a two line
// header pushes the whole transcript down and reads as a broken panel.

const web = join(import.meta.dir, "..", "..");
const css = readFileSync(join(web, "app/globals.css"), "utf8");
const view = readFileSync(join(web, "components/ConversationView.tsx"), "utf8");
// ConversationView owns the squeeze hook; the head row it measures is drawn
// by ConversationHeaderBar.
const headerBar = readFileSync(join(web, "components/conversation/ConversationHeaderBar.tsx"), "utf8");
const placeholder = readFileSync(join(web, "components/ConversationPlaceholder.tsx"), "utf8");

/** A row whose content width depends on the squeeze level it carries. */
function fakeRow(clientWidth: number, widthAtLevel: (level: number) => number, partWidth = 0) {
  const attrs = new Map<string, string>();
  const level = () => (attrs.get("data-squeeze")?.split(" ").length ?? 0);
  const counts = { reads: 0, writes: 0 };
  return {
    counts,
    getAttribute: (k: string) => attrs.get(k) ?? null,
    setAttribute: (k: string, v: string) => { counts.writes++; attrs.set(k, v); },
    removeAttribute: (k: string) => { counts.writes++; attrs.delete(k); },
    get clientWidth() { return clientWidth; },
    get scrollWidth() { counts.reads++; return widthAtLevel(level()); },
    // One part per level, `partWidth` wide while its level is not shed.
    querySelectorAll: (sel: string) => {
      const k = Number(sel.replace(".cq-sq", ""));
      return k > level() && partWidth ? [{ getBoundingClientRect: () => ({ width: partWidth }) }] : [];
    },
    attr: () => attrs.get("data-squeeze"),
  };
}

/** Run passes the way frames would, until one asks for no further check. */
function settle(row: ReturnType<typeof fakeRow>, max: number) {
  const el = row as unknown as HTMLElement;
  const state = squeezeStateFor(el);
  const perPass: Array<{ reads: number; writes: number }> = [];
  let more = true;
  while (more) {
    const before = { ...row.counts };
    more = squeezeStep(el, max, state);
    perPass.push({ reads: row.counts.reads - before.reads, writes: row.counts.writes - before.writes });
    if (perPass.length > 20) throw new Error("did not settle");
  }
  return { level: state.level, perPass, state };
}

describe("conversation header squeeze", () => {
  test("no rule lets the squeeze row wrap", () => {
    const rules = [...css.matchAll(/([^{}]*cq-squeeze-row[^{}]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(0);
    for (const [, , body] of rules) expect(body).not.toMatch(/flex-wrap:\s*wrap/);
  });

  test("the conversation head row is not the wrapping panel variant", () => {
    for (const src of [headerBar, placeholder]) {
      const heads = src.match(/className="cc-panel__head[^"]*gap-2 min-w-0"/g) ?? [];
      expect(heads.length).toBe(1);
      expect(heads[0]).not.toContain("cc-panel__head--flow");
    }
  });

  test("the deepest level releases the title floor instead of wrapping", () => {
    const max = Number(view.match(/useSqueezeToFit\(squeezeRowRef, (\d+)\)/)?.[1]);
    expect(max).toBeGreaterThan(0);
    const deepest = new RegExp(`\\[data-squeeze~="${max}"\\] \\.cc-panel__title \\{ min-width: 0; \\}`);
    expect(css).toMatch(deepest);
  });

  test("the squeeze settles on the smallest level that fits", () => {
    const row = fakeRow(500, (l) => 800 - l * 100);
    expect(settle(row, 7).level).toBe(3);
    expect(row.attr()).toBe("1 2 3");
  });

  // Each restyle-then-read is a whole-page layout (ct-97578), so a pass may
  // read the row once and write once; checks wait for the next frame.
  test("every pass reads the row once and writes at most one level", () => {
    const row = fakeRow(500, (l) => 800 - l * 100);
    for (const pass of settle(row, 7).perPass) {
      expect(pass.reads).toBe(1);
      expect(pass.writes).toBeLessThanOrEqual(1);
    }
  });

  test("a raise jumps to the level whose parts cover the overflow", () => {
    // Shedding a part frees its width plus a gap, so the estimate undershoots
    // the saving; the squeeze still lands on the smallest level.
    const row = fakeRow(500, (l) => 830 - l * 110, 100);
    const { level, perPass } = settle(row, 7);
    expect(level).toBe(3);
    expect(perPass.length).toBeLessThanOrEqual(3);
  });

  test("the same level from any starting level", () => {
    for (let from = 0; from <= 7; from++) {
      const row = fakeRow(500, (l) => 800 - l * 100);
      if (from) row.setAttribute("data-squeeze", Array.from({ length: from }, (_, i) => i + 1).join(" "));
      expect(settle(row, 7).level).toBe(3);
      expect(row.attr()).toBe("1 2 3");
    }
  });

  test("a pass where nothing that fits changed reads once and writes nothing", () => {
    const row = fakeRow(500, (l) => 800 - l * 100);
    const { state } = settle(row, 7);
    const before = { ...row.counts };
    expect(squeezeStep(row as unknown as HTMLElement, 7, state)).toBe(false);
    expect(row.counts.reads - before.reads).toBe(1);
    expect(row.counts.writes - before.writes).toBe(0);
  });

  test("the squeeze clears the attribute when the row already fits", () => {
    const row = fakeRow(900, () => 800);
    row.setAttribute("data-squeeze", "1 2 3 4");
    expect(settle(row, 7).level).toBe(0);
    expect(row.attr()).toBeUndefined();
  });
});
