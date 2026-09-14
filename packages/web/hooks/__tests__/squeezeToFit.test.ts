import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applySqueeze } from "../useSqueezeToFit";

// The conversation header is one row. It sheds chip detail step by step and
// lets the title truncate last, but it never grows a second line: a two line
// header pushes the whole transcript down and reads as a broken panel.

const web = join(import.meta.dir, "..", "..");
const css = readFileSync(join(web, "app/globals.css"), "utf8");
const view = readFileSync(join(web, "components/ConversationView.tsx"), "utf8");
const placeholder = readFileSync(join(web, "components/ConversationPlaceholder.tsx"), "utf8");

/** A row whose content width depends on the squeeze level it carries. */
function fakeRow(clientWidth: number, widthAtLevel: (level: number) => number) {
  const attrs = new Map<string, string>();
  const level = () => (attrs.get("data-squeeze")?.split(" ").length ?? 0);
  return {
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    removeAttribute: (k: string) => attrs.delete(k),
    get clientWidth() { return clientWidth; },
    get scrollWidth() { return widthAtLevel(level()); },
    attr: () => attrs.get("data-squeeze"),
  };
}

describe("conversation header squeeze", () => {
  test("no rule lets the squeeze row wrap", () => {
    const rules = [...css.matchAll(/([^{}]*cq-squeeze-row[^{}]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(0);
    for (const [, , body] of rules) expect(body).not.toMatch(/flex-wrap:\s*wrap/);
  });

  test("the conversation head row is not the wrapping panel variant", () => {
    for (const src of [view, placeholder]) {
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

  test("applySqueeze picks the smallest level that fits", () => {
    const row = fakeRow(500, (l) => 800 - l * 100);
    expect(applySqueeze(row as unknown as HTMLElement, 7)).toBe(3);
    expect(row.attr()).toBe("1 2 3");
  });

  test("applySqueeze clears the attribute when the row already fits", () => {
    const row = fakeRow(900, () => 800);
    row.setAttribute("data-squeeze", "1 2 3 4");
    expect(applySqueeze(row as unknown as HTMLElement, 7)).toBe(0);
    expect(row.attr()).toBeUndefined();
  });
});
