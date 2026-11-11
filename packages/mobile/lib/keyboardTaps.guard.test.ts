import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// With the keyboard up, a tap on a transcript does one of two things:
//
// - lands on something with an action (a link, button, tool row, image, a
//   reaction): it acts on the first tap and the keyboard stays;
// - lands on anything else (empty space, plain message text): the keyboard
//   goes down.
//
// A tap in the composer (send, attachments, slash pills, mention strip,
// suggestion chips) never puts the keyboard away, and a drag on the
// transcript still does.
//
// React Native gives the first rule with keyboardShouldPersistTaps="handled"
// on the transcript list. 'always' (what these lists had) keeps the keyboard
// up on every tap, so tapping outside the composer did nothing. 'handled'
// only dismisses when no child claims the tap, and a Pressable or Touchable
// claims every tap unless it is disabled, even one with no onPress. So a row
// that holds a long-press menu dismisses on a plain tap itself, and a
// pressable whose onPress can be undefined says disabled in that case.

const root = `${import.meta.dir}/..`;
const read = (path: string) => readFileSync(join(root, path), "utf8");

const TRANSCRIPTS = ["app/session/[id].tsx", "app/chat/[id].tsx", "app/chat/thread/[id].tsx"];

// Horizontal strips that sit above the keyboard, in the composer.
const COMPOSER_STRIPS = [
  "components/session/SlashCommandPills.tsx",
  "components/chat/MentionStrip.tsx",
  "components/session/MessageComposer.tsx",
];

// Files that draw transcript rows (session and chat).
const ROW_RENDERERS = [
  "app/session/[id].tsx",
  "components/chat/MessageRow.tsx",
  "components/session/UserRows.tsx",
  "components/session/CastCommandBlock.tsx",
  "components/session/FlowCard.tsx",
  "components/session/SentFileBlock.tsx",
  "components/session/StructuredResultBlock.tsx",
  "components/session/WorkflowEventBlock.tsx",
  "components/MarkdownRenderer.tsx",
  "components/CodeText.tsx",
  "components/CastDiff.tsx",
  "components/PermissionCard.tsx",
  "components/hosted/ApprovalCard.tsx",
  "components/hosted/ReplyChips.tsx",
  "components/hosted/Notice.tsx",
  "components/hosted/Steps.tsx",
];

const persistValues = (source: string) =>
  [...source.matchAll(/keyboardShouldPersistTaps="(\w+)"/g)].map((m) => m[1]);

/** The opening tag of every Pressable / Touchable, line comments dropped. */
function pressableTags(source: string): { line: number; tag: string }[] {
  const out: { line: number; tag: string }[] = [];
  const re = /<(Pressable|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback)\b/g;
  for (const m of source.matchAll(re)) {
    let i = m.index! + m[0].length;
    let depth = 0;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0 && source[i - 1] !== "=") break;
    }
    const tag = source
      .slice(m.index!, i + 1)
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\s+/g, " ");
    out.push({ line: source.slice(0, m.index!).split("\n").length, tag });
  }
  return out;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("a tap outside the composer puts the keyboard away", () => {
  test.each(TRANSCRIPTS)("%s: the transcript dismisses on a tap nothing takes, and on a drag", (path) => {
    const source = read(path);
    expect(persistValues(source)).toEqual(["handled"]);
    // 'interactive' alone degrades to 'none' on Android.
    expect(source).toContain("keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}");
  });

  test("a session bubble dismisses on a plain tap and keeps its long-press menu", () => {
    const tags = pressableTags(read("app/session/[id].tsx")).filter((t) =>
      t.tag.includes("onLongPress={handleLongPress}"),
    );
    expect(tags.length).toBe(1);
    // Tap-to-expand on a collapsed turn stays; every other plain tap dismisses.
    expect(tags[0].tag).toMatch(/onPress=\{[^}]*\? handleTapToExpand : Keyboard\.dismiss\}/);
  });

  test("a chat row dismisses on a plain tap and keeps its long-press menu", () => {
    const tags = pressableTags(read("components/chat/MessageRow.tsx")).filter((t) =>
      t.tag.includes("onLongPress={() => onLongPress?.(message)}"),
    );
    expect(tags.length).toBe(1);
    expect(tags[0].tag).toContain("onPress={Keyboard.dismiss}");
  });

  test.each(ROW_RENDERERS)("%s: no pressable takes a tap it does nothing with", (path) => {
    const bad = pressableTags(read(path))
      .filter(({ tag }) => !/\bdisabled\b/.test(tag))
      .filter(({ tag }) => !tag.includes("onPress=") || /onPress=\{[^}]*: undefined\}/.test(tag))
      .map(({ line, tag }) => `${path}:${line} ${tag.slice(0, 120)}`);
    expect(bad).toEqual([]);
  });
});

describe("a tap in the composer never puts the keyboard away", () => {
  test.each(COMPOSER_STRIPS)("%s: its strip persists every tap", (path) => {
    const values = persistValues(read(path));
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((v) => v === "always")).toBe(true);
  });

  test("only composer strips persist every tap", () => {
    // 'always' on a list or a page keeps the keyboard up wherever the person
    // taps; anywhere but a strip above the keyboard that is the bug this file
    // guards.
    const files = [...walk(join(root, "app")), ...walk(join(root, "components"))];
    const offenders = files
      .map((f) => relative(root, f))
      .filter((f) => !COMPOSER_STRIPS.includes(f))
      .filter((f) => persistValues(readFileSync(join(root, f), "utf8")).includes("always"));
    expect(offenders).toEqual([]);
  });
});
