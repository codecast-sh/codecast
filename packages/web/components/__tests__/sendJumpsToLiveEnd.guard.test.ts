import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ct-97968: after sending, the transcript could be left away from the end.
// When the view is a paged window (target mode: a deep-linked message or a
// search hit, so `hasMoreBelow` is true), the newest messages, including the
// one just sent, are not loaded. `virtualizer.scrollToEnd` only reaches the
// end of the loaded rows; reaching the real end takes `onJumpToEnd`, which the
// "Scroll to bottom" button already uses. The send path must reach it too.
//
// ConversationView is too large to mount in a test, so this follows the send
// handler through the functions it calls, inside ConversationView.tsx, and
// asserts that `onJumpToEnd` is reachable from it.

const src = readFileSync(join(import.meta.dir, "..", "ConversationView.tsx"), "utf8");

/** The statement starting at `at`, up to the first `;` outside any bracket. */
function statement(at: number): string {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === ";" && depth === 0) return src.slice(at, i + 1);
    if (depth < 0) return src.slice(at, i);
  }
  return src.slice(at);
}

/** Every definition of `name` in the file: `const name = …`, `function name…` or `name.current = …`. */
function definitions(name: string): string[] {
  const re = new RegExp(`(?:const|let|function)\\s+${name}\\b|\\b${name}\\.current\\s*=(?!=)`, "g");
  return [...src.matchAll(re)].map((m) => statement(m.index! + m[0].length));
}

/** Whether `target` is reached from `name` by following called identifiers. */
function reaches(name: string, target: string, depth = 4, seen = new Set<string>()): boolean {
  if (seen.has(name) || depth < 0) return false;
  seen.add(name);
  for (const body of definitions(name)) {
    if (new RegExp(`\\b${target}\\b`).test(body)) return true;
    for (const m of body.matchAll(/\b([A-Za-z_$][\w$]*)(?:\.current)?\s*(?:\?\.)?\(/g)) {
      if (reaches(m[1], target, depth - 1, seen)) return true;
    }
  }
  return false;
}

describe("sending a message lands on the real end of the transcript (ct-97968)", () => {
  test("the send handler exists where the composer is wired", () => {
    expect(src).toMatch(/onMessageSent=\{handleMessageSent\}/);
    expect(definitions("handleMessageSent").length).toBeGreaterThan(0);
  });

  test("with newer messages not loaded, a send jumps to the live end (onJumpToEnd), not just the loaded rows' end", () => {
    expect(reaches("handleMessageSent", "onJumpToEnd")).toBe(true);
  });
});
