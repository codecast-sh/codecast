import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { shouldHoldChatLanding } from "../chat/chatLanding";

const css = readFileSync(new URL("../chat/chat.css", import.meta.url), "utf8");
const list = readFileSync(new URL("../chat/ChatMessageList.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../../app/chat/page.tsx", import.meta.url), "utf8");
const hook = readFileSync(new URL("../../hooks/useBottomAnchoredList.ts", import.meta.url), "utf8");

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

  test("a thread pins to the composer the same way a channel does", () => {
    expect(css).not.toMatch(/\.ch-thread \.ch-list-fill/);
    expect(rule(".ch-list-fill")["justify-content"]).toBe("flex-end");
  });

  test("opening a list pins to the bottom unless a message link names a row", () => {
    expect(list).not.toMatch(/const initialIndex = newRuleIndex/);
    expect(list).toMatch(/holdLanding:\s*holdTarget/);
    expect(list).toMatch(/shouldHoldChatLanding\(targetIndex, rows\.length\)/);
    expect(hook).toMatch(/holdLanding\?: boolean/);
    expect(hook).toMatch(/if \(holdLanding\) \{/);
    expect(hook).toMatch(/must paint already at the tail/);
  });

  test("a named row on the tail does not hold the bottom pin", () => {
    expect(shouldHoldChatLanding(-1, 40)).toBe(false);
    expect(shouldHoldChatLanding(39, 40)).toBe(false);
    expect(shouldHoldChatLanding(35, 40)).toBe(false);
    expect(shouldHoldChatLanding(20, 40)).toBe(true);
    expect(shouldHoldChatLanding(0, 3)).toBe(false);
  });

  test("a tail target does not center-scroll", () => {
    expect(list).toMatch(/if \(holdTarget\) \{/);
    expect(list).toMatch(/scrollToIndex\(targetIndexRef\.current, \{ align: "center" \}\)/);
    expect(list).toMatch(/useLayoutEffect\(\(\) => \{\n    if \(!targetMessageId/);
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
