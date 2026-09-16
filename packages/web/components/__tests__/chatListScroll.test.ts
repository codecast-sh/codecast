import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../chat/chat.css", import.meta.url), "utf8");
const list = readFileSync(new URL("../chat/ChatMessageList.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../../app/chat/page.tsx", import.meta.url), "utf8");

function rule(selector: string): Record<string, string> {
  const at = css.indexOf(`\n${selector} {`);
  expect(at).toBeGreaterThan(-1);
  const body = css.slice(at + selector.length + 3, css.indexOf("}", at));
  return Object.fromEntries(
    body.split(";").flatMap((declaration) => {
      const colon = declaration.indexOf(":");
      return colon < 0
        ? []
        : [[declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()]];
    }),
  );
}

describe("chat list scrolling", () => {
  test("the scroller is a block, not a flex column that pins with margin-top auto", () => {
    const scroller = rule(".ch-list");
    expect(scroller["overflow-y"]).toBe("auto");
    expect(scroller["display"]).toBeUndefined();
    expect(scroller["flex-direction"]).toBeUndefined();
    expect(scroller["justify-content"]).toBeUndefined();
  });

  test("a short transcript pins to the composer on an inner fill that can grow", () => {
    const fill = rule(".ch-list-fill");
    expect(fill["min-height"]).toBe("100%");
    expect(fill["display"]).toBe("flex");
    expect(fill["flex-direction"]).toBe("column");
    expect(fill["justify-content"]).toBe("flex-end");
    expect(rule(".ch-list-sizer")["margin-top"]).toBeUndefined();
  });

  test("a thread hangs from its root instead of floating to the bottom", () => {
    expect(rule(".ch-thread .ch-list-fill")["justify-content"]).toBe("flex-start");
  });

  test("the list wraps the sizer in the fill", () => {
    expect(list).toMatch(/<div className="ch-list-fill">[\s\S]*ch-list-sizer/);
    expect(list).not.toMatch(/className="ch-list"[^>]*>\s*\{isLoadingOlder/);
  });

  test("team chat wraps the shell in a box with a real height", () => {
    expect(page).toMatch(/standalone \? "ch-community-page" : "h-full min-h-0"/);
    expect(page).not.toMatch(/standalone \? "ch-community-page" : undefined/);
  });
});
