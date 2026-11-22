import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Headers and reference chips kept growing past what their content needs
// (ct-87448): a role page's header ran two rows on a phone, and a reference
// with a long title in a sentence became a box that jumped to its own line
// or stood two lines tall inside one. Both now come from one shared rule in
// globals.css, and this guard fails when either rule loosens.
//   - .object-head-row: an object page's header is the conversation header's
//     height (--cc-panel-head-h), with no vertical padding to stretch it.
//   - .entity-ref--flow: a plain reference is an inline run on the text's
//     own line height, with no vertical padding.
// jsdom cannot lay out a line, so the measured proof (line heights in
// headless Chrome) is in the task's evidence; this holds the rules it measured.

const ROOT = join(import.meta.dir, "..", "..");
const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** The declarations of the first top-level rule whose selector is exactly `selector`. */
function ruleBody(selector: string): Record<string, string> {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`globals.css has no rule for ${selector}`);
  const out: Record<string, string> = {};
  for (const decl of m[1].replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const i = decl.indexOf(":");
    if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
  }
  return out;
}

const VERTICAL = /^(padding(-top|-bottom|-block)?|min-height|line-height|height)$/;

describe("object page header is one conversation-header row", () => {
  test(".object-head-row reads the session header's height token and adds no vertical padding", () => {
    const r = ruleBody(".object-head-row");
    expect(r.height).toBe("var(--cc-panel-head-h)");
    expect(r["padding-block"]).toBe("0");
    expect(r["min-height"]).toBe("0");
    for (const k of Object.keys(r)) if (VERTICAL.test(k)) expect(["height", "padding-block", "min-height"]).toContain(k);
  });

  test("the session header's .cc-panel__head reads the same token", () => {
    expect(ruleBody(".cc-panel__head").height).toBe("var(--cc-panel-head-h)");
  });

  test("the role page's [data-scope-head] wears the shared row and no vertical spacing of its own", () => {
    const src = read("components/org/scope/ScopePage.tsx");
    const head = src.match(/<header[^>]*data-scope-head[^>]*>/)?.[0];
    expect(head).toBeDefined();
    expect(head!).toContain("object-head-row");
    expect(head!).not.toMatch(/\b(py|pt|pb|h|min-h)-[\w[\]./]+/);
  });
});

describe("a reference in prose sits in the text line", () => {
  test(".entity-ref--flow is inline on the line's own height, unpadded vertically", () => {
    const r = ruleBody(".entity-ref--flow");
    expect(r.display).toBe("inline");
    expect(r["line-height"]).toBe("inherit");
    expect(r["padding-block"]).toBe("0");
    for (const k of Object.keys(r)) if (VERTICAL.test(k)) expect(["line-height", "padding-block"]).toContain(k);
  });

  test("its title wraps, but never away from its icon", () => {
    expect(ruleBody(".entity-ref--flow")["white-space"]).toBe("nowrap");
    expect(ruleBody(".entity-ref--flow .entity-ref__label")["white-space"]).toBe("normal");
  });

  test("its icon is the text's size and hangs on the baseline", () => {
    const r = ruleBody(".entity-ref--flow .entity-ref__icon");
    expect(r.height).toBe("1em");
    expect(r["vertical-align"]).toBe("-0.125em");
  });

  test("EntityIdPill gives the flowing reference no box of its own", () => {
    const src = read("components/EntityIdPill.tsx");
    const cls = src.match(/className=\{`not-prose entity-ref\$\{[^`]*`\}/)?.[0];
    expect(cls).toBeDefined();
    // The flow branch adds only the shared class; the box (inline-flex, leading-none)
    // belongs to the other branch.
    expect(cls!).toContain('flows ? " entity-ref--flow" : " whitespace-normal inline-flex');
    // Nothing on the shared part of the class list pads or sizes it vertically.
    const shared = cls!.replace(/\$\{flows \? [^}]*\}/, "");
    expect(shared).not.toMatch(/[\s"](py|pt|pb|h|min-h|leading|whitespace)-[\w[\]./]+/);
  });
});
