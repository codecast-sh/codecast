import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// "Dismiss all N" (the old-sessions prompt in the inbox panel) clears dozens of
// sessions in one press. A bulk, hard-to-take-back action goes through the
// shared confirm flow (components/consequential), its toast offers Undo, and
// the server is sent the exact set the prompt counted rather than an age
// cutoff it re-derives (ct-98161).
const src = readFileSync(join(import.meta.dir, "..", "..", "components", "GlobalSessionPanel.tsx"), "utf8");

function handlerBody(): string {
  const start = src.indexOf("const handleDismissStale");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("}, [", start);
  return src.slice(start, end);
}

function dismissAllButton(): string {
  const label = src.indexOf("`Dismiss all ${");
  expect(label).toBeGreaterThan(-1);
  const open = src.lastIndexOf("<", src.lastIndexOf("onClick", label));
  return src.slice(open, label);
}

describe("Dismiss all old sessions", () => {
  test("the press is not a bare click: it goes through the consequential confirm flow", () => {
    expect({ usesConsequentialFlow: /components\/consequential/.test(src) }).toEqual({ usesConsequentialFlow: true });
    expect(dismissAllButton()).not.toMatch(/onClick=\{handleDismissStale\}/);
  });

  test("the toast after the dismiss offers Undo", () => {
    expect(handlerBody()).toMatch(/label:\s*"Undo"/);
  });

  test("the server is sent the counted set, not an age cutoff", () => {
    const body = handlerBody();
    expect(body).not.toMatch(/dismissStaleMutation\(\{\s*older_than_days/);
    expect(body).toMatch(/dismissStaleMutation\(\{[^}]*\bids\b/);
  });
});
