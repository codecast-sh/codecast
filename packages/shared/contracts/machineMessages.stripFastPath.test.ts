// stripInjectionNoise, stripPastedContent and stripMentionContext skip a
// pattern on a text that cannot match it. These tests hold them to the
// patterns run unconditionally, on texts built to sit on every boundary.
import { describe, expect, test } from "bun:test";
import { stripInjectionNoise, stripMentionContext, stripPastedContent } from "./machineMessages";

const LEGACY_MENTION_CONTEXT_RE =
  /\n\n---\n(?=### (?:Task|Plan|Doc|Session|Trigger|Label): |[\s\S]{0,800}?<untrusted-[0-9a-f]+ source=)[\s\S]*?\n> `cast (?:task context|plan show|read|trigger log|doc read|sessions)[^\n]*\n---(?=\n|$)\n?/g;
const WIRE_TAGS = ["session-message", "agent-message", "user-message", "task-comment", "decision-discussion", "line-chat", "teammate-message", "scheduled-task", "session-escalation"];
const WIRE_TAG_JUNK_PREFIX = new RegExp(`^[^<\\s]{1,2}(?=<(?:${WIRE_TAGS.join("|")})[\\s>])`);

const pastedReference = (text: string) =>
  text
    .replace(/<pasted_content(?=[\s>]|$)[^>]*(?:>|$)\r?\n?/g, "")
    .replace(/(?:\r?\n)?<\/pasted_content(?=[\s>]|$)[^>]*(?:>|$)/g, "");
const mentionReference = (text: string) =>
  text.replace(/\n*<mention-context>[\s\S]*?(?:<\/mention-context>\n?|$)/g, "").replace(LEGACY_MENTION_CONTEXT_RE, "");
const noiseReference = (text: string) =>
  mentionReference(pastedReference(text))
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<task-reminder>[\s\S]*?<\/task-reminder>/g, "")
    .replace(/^[\x00-\x1f\s]+/, "")
    .replace(WIRE_TAG_JUNK_PREFIX, "");

// Pieces a real message is made of, whole and cut short, so a text can hold an
// opening tag with no close, a close with no opening, and one nested in another.
const PIECES = [
  "Fix the login page. ", "a < b && c > d ", "\n", "\n\n", "\r\n", " ", "\x01\x0b", "h", "ab",
  "<pasted_content id=\"a1\">", "<pasted_content>\n", "</pasted_content id=\"a1\">", "\n</pasted_content>", "<pasted_content", "</pasted_content", "pasted_content",
  "<mention-context>", "</mention-context>", "</mention-context>\n", "\n\n<mention-context>\n## Task\nbody\n",
  "\n\n---\n", "### Task: ct-1 Title\n", "### Doc: Notes\n", "<untrusted-0af3 source=\"doc\">", "\n> `cast task context ct-1`\n---", "\n> `cast doc read abc`\n---\n", "---",
  "<system-reminder>", "</system-reminder>", "<task-reminder>", "</task-reminder>", "<system-reminder>be brief</system-reminder>", "<task-reminder>t</task-reminder>",
  "<session-message from=\"jx7abc\">", "<user-message from=\"a\">hi</user-message>", "<scheduled-task title=\"x\">", "<div>markup</div>", "```ts\nconst x = 1 < 2;\n```\n",
];

function* texts(count: number, seed: number): Generator<string> {
  let s = seed >>> 0;
  const next = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < count; i++) {
    const n = 1 + Math.floor(next() * 9);
    let out = "";
    for (let k = 0; k < n; k++) out += PIECES[Math.floor(next() * PIECES.length)];
    yield out;
  }
}

describe("the strip functions skip only what cannot match", () => {
  test("every piece on its own", () => {
    for (const piece of PIECES) {
      expect(stripPastedContent(piece)).toBe(pastedReference(piece));
      expect(stripMentionContext(piece)).toBe(mentionReference(piece));
      expect(stripInjectionNoise(piece)).toBe(noiseReference(piece));
    }
  });

  test("20,000 texts assembled from the pieces", () => {
    let changed = 0;
    for (const text of texts(20_000, 0x5eed)) {
      const want = noiseReference(text);
      if (want !== text) changed++;
      expect(stripPastedContent(text)).toBe(pastedReference(text));
      expect(stripMentionContext(text)).toBe(mentionReference(text));
      expect(stripInjectionNoise(text)).toBe(want);
    }
    // The texts do exercise the patterns: most of them lose something.
    expect(changed).toBeGreaterThan(10_000);
  });

  test("a text with nothing to remove comes back as the same string", () => {
    const text = "Plain words, a comparison a < b, and a fence:\n```\nx\n```";
    expect(stripInjectionNoise(text)).toBe(text);
  });
});
