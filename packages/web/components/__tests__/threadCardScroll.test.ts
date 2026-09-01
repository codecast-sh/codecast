import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../threads/threads.css", import.meta.url), "utf8");

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

describe("expanded chat thread scrolling", () => {
  test("keeps replies in the page scroll instead of a nested scroller", () => {
    const replies = rule(".th-kind-chat .th-card-replies");
    expect(css.indexOf("\n.th-kind-chat .th-card-replies {")).toBeGreaterThan(
      css.indexOf("\n.th-card-auto .th-card-replies {"),
    );
    expect(replies["max-height"]).toBe("none");
    expect(replies["overflow-y"]).toBe("visible");
  });
});
