/**
 * The pure seams of the engine wrapper: our vocabulary → the engine's, and
 * the flow-level auto-shot placement. Everything here runs without a browser.
 */

import { describe, expect, test } from "bun:test";
import { lastMutatingIndex, parseEngineRefs, translate } from "./cliEngine.js";

describe("translate: text", () => {
  test("bare text reads the whole page", () => {
    expect(translate("text", [], null)).toEqual([{ args: ["read"] }]);
  });

  test("a selector positional reads one element via get text", () => {
    expect(translate("text", ["div[role=main]"], null)).toEqual([{ args: ["get", "text", "div[role=main]"] }]);
  });

  test("a ref positional reads one element, in engine spelling", () => {
    expect(translate("text", ["#e42"], null)).toEqual([{ args: ["get", "text", "@e42"] }]);
  });

  test("-s / --selector spell the same thing", () => {
    expect(translate("text", ["-s", "div.a3s"], null)).toEqual([{ args: ["get", "text", "div.a3s"] }]);
    expect(translate("text", ["--selector", "div.a3s"], null)).toEqual([{ args: ["get", "text", "div.a3s"] }]);
  });

  test("a leading flag still means the whole-page read", () => {
    expect(translate("text", ["--outline"], null)).toEqual([{ args: ["read", "--outline"] }]);
  });

  test("a URL positional reads the document, not an element", () => {
    expect(translate("text", ["https://example.com/guide"], null)).toEqual([
      { args: ["read", "https://example.com/guide"] },
    ]);
  });
});

describe("translate: read passes through", () => {
  test("read is its own verb, flags intact", () => {
    expect(translate("read", ["--outline"], null)).toEqual([{ args: ["read", "--outline"] }]);
  });

  test("read -s <sel> is absorbed as scoped element text", () => {
    expect(translate("read", ["-s", "[role=main]"], null)).toEqual([{ args: ["get", "text", "[role=main]"] }]);
    expect(translate("read", ["--selector", "div.a3s", "--json"], null)).toEqual([
      { args: ["get", "text", "div.a3s", "--json"] },
    ]);
  });

  test("read with a URL keeps -s out of the way (engine reports it)", () => {
    expect(translate("read", ["https://x.com", "-s", "div"], null)).toEqual([
      { args: ["read", "https://x.com", "-s", "div"] },
    ]);
  });

  test("diff is reachable for snapshot deltas", () => {
    expect(translate("diff", ["snapshot"], null)).toEqual([{ args: ["diff", "snapshot"] }]);
  });
});

describe("parseEngineRefs", () => {
  // The one rule that was actually got wrong: a ref is not always the first
  // thing in its bracket. Elements with state render as
  // `[expanded=false, ref=e162]`, and a filter looking for the literal
  // "[ref=" hid every such element from `find` — on a live GitHub page that
  // was 35 of 254 elements, including the Watch and Code buttons.
  const stdout = [
    "- generic",
    '  - link "All issues" [ref=e9]',
    '  - button "Watch: Participating in anthropics/claude-code." [expanded=false, ref=e162]',
    "  - listitem [level=1]",
    '    - link "anthropics" [ref=e47]',
    '  - checkbox "Remember me" [checked, ref=e77]',
    '  - StaticText "Watch"',
  ].join("\n");

  test("keeps refs whose bracket starts with flags, not just bare [ref=", () => {
    expect(parseEngineRefs(stdout).map((i) => i.name)).toEqual([
      "All issues",
      "Watch: Participating in anthropics/claude-code.",
      "anthropics",
      "Remember me",
    ]);
  });

  test("parses role and keeps the printable line", () => {
    const watch = parseEngineRefs(stdout)[1];
    expect(watch.role).toBe("button");
    expect(watch.line).toBe(
      '- button "Watch: Participating in anthropics/claude-code." [expanded=false, ref=e162]',
    );
  });

  test("lines without a ref never become items", () => {
    const roles = parseEngineRefs(stdout).map((i) => i.role);
    expect(roles).not.toContain("listitem");
    expect(roles).not.toContain("StaticText");
  });
});

describe("translate: -s selector quoting", () => {
  test("unquoted attribute values are quoted for snapshot scoping", () => {
    expect(translate("snapshot", ["-i", "-s", "div[role=main]"], null)).toEqual([
      { args: ["snapshot", "-i", "-s", 'div[role="main"]'] },
    ]);
  });

  test("already-quoted and attribute-free selectors pass unchanged", () => {
    expect(translate("snapshot", ["-s", 'div[role="main"]'], null)).toEqual([
      { args: ["snapshot", "-s", 'div[role="main"]'] },
    ]);
    expect(translate("diff", ["snapshot", "--selector", "#main .list"], null)).toEqual([
      { args: ["diff", "snapshot", "--selector", "#main .list"] },
    ]);
  });
});

describe("lastMutatingIndex", () => {
  test("names the last page-changing step, not the first", () => {
    expect(lastMutatingIndex(["open example.com", "snapshot -i", "click #e2", "get text div.a3s"])).toBe(2);
  });

  test("a flow with no page-changing step has none", () => {
    expect(lastMutatingIndex(["snapshot -i", "get text div.a3s"])).toBe(-1);
  });

  test("type only counts when it submits", () => {
    expect(lastMutatingIndex(["open x.com", 'type #e1 "hi"'])).toBe(0);
    expect(lastMutatingIndex(["open x.com", 'type #e1 "hi" --submit'])).toBe(1);
  });
});
