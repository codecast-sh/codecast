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
// ConversationView owns the squeeze hook; the head row it measures is drawn
// by ConversationHeaderBar.
const headerBar = readFileSync(join(web, "components/conversation/ConversationHeaderBar.tsx"), "utf8");
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
    for (const src of [headerBar, placeholder]) {
      const heads = src.match(/className="cc-panel__head[^"]*gap-2 min-w-0"/g) ?? [];
      expect(heads.length).toBe(1);
      expect(heads[0]).not.toContain("cc-panel__head--flow");
    }
  });

  test("the deepest levels release the title floor instead of wrapping", () => {
    const max = Number(view.match(/useSqueezeToFit\(squeezeRowRef, (\d+)\)/)?.[1]);
    expect(max).toBeGreaterThan(1);
    // Levels are cumulative: the deepest carries every token below it.
    const release = Number(css.match(/\[data-squeeze~="(\d+)"\] \.cc-panel__title \{ min-width: 0; \}/)?.[1]);
    expect(release).toBeGreaterThan(0);
    expect(release).toBeLessThanOrEqual(max);
  });

  // The runner pill (machine | owners | terminal) is how a person reaches who
  // runs and who owns a session, so the last level sheds the unkept actions
  // before the cluster clips, and the runner is never one of them.
  test("the last level sheds the unkept actions before it clips the runner", () => {
    const max = Number(view.match(/useSqueezeToFit\(squeezeRowRef, (\d+)\)/)?.[1]);
    expect(css).toContain(`[data-sv-convhead] [data-squeeze~="${max}"] [data-cc-conv-actions] > :not([data-cc-keep], [data-cc-squeeze-keep]) { display: none !important; }`);
    const clip = css.match(/\[data-squeeze~="(\d+)"\] \[data-cc-conv-actions\] \{[^}]*justify-content: flex-end/);
    expect(Number(clip?.[1])).toBe(max);
    expect(view).toMatch(/<span data-cc-runner data-cc-keep="live"/);
    // The Share control (headerExtra) stays too: every object page carries one.
    expect(view).toContain(`{headerExtra && <span data-cc-squeeze-keep className="contents">{headerExtra}</span>}`);
    // The dormant chip yields its width before the cluster does.
    expect(css).toMatch(/\[data-squeeze~="(\d)"\] \[data-dormant-wake\] \{ min-width: 0;/);
  });

  test("applySqueeze picks the smallest level that fits", () => {
    const row = fakeRow(500, (l) => 800 - l * 100);
    expect(applySqueeze(row as unknown as HTMLElement, 7)).toBe(3);
    expect(row.attr()).toBe("1 2 3");
  });

  // The search starts from the last answer; it must land on the same level
  // from anywhere, and a pass where nothing moved must measure only twice.
  test("applySqueeze finds the same level from any starting level", () => {
    for (let from = 0; from <= 7; from++) {
      const row = fakeRow(500, (l) => 800 - l * 100);
      expect(applySqueeze(row as unknown as HTMLElement, 7, from)).toBe(3);
      expect(row.attr()).toBe("1 2 3");
    }
  });

  test("applySqueeze measures twice when the last answer still holds", () => {
    let reads = 0;
    const row = fakeRow(500, (l) => { reads++; return 800 - l * 100; });
    expect(applySqueeze(row as unknown as HTMLElement, 7, 3)).toBe(3);
    expect(reads).toBe(2);
  });

  test("applySqueeze clears the attribute when the row already fits", () => {
    const row = fakeRow(900, () => 800);
    row.setAttribute("data-squeeze", "1 2 3 4");
    expect(applySqueeze(row as unknown as HTMLElement, 7)).toBe(0);
    expect(row.attr()).toBeUndefined();
  });
});
