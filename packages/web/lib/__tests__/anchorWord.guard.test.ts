import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codeLines, walkSources, WEB_ROOT, MOBILE_ROOT } from "./sourceWalk";

// One agent at the root (docs/architecture/org-staffing.md S22): the word
// anchor leaves every surface a person reads. Where a sentence needs the
// thing it says the role's name, or "the workspace's agent". The tables, the
// functions, the routes and the `cast anchor` command keep their names, so
// this guard reads only what a person reads: string literals and JSX text,
// never identifiers, never comments.

const REPO = join(WEB_ROOT, "..", "..");
const ROOTS = [
  join(WEB_ROOT, "app"), join(WEB_ROOT, "components"), join(WEB_ROOT, "lib"), join(WEB_ROOT, "hooks"),
  join(MOBILE_ROOT, "app"), join(MOBILE_ROOT, "components"), join(MOBILE_ROOT, "lib"),
  join(REPO, "packages", "cli", "src"),
  join(REPO, "packages", "shared", "contracts"),
  join(REPO, "packages", "convex", "convex"),
];

// The word on its own: not a path (/anchor), a handle (@anchor), a field
// (anchor_id), a key (anchor.toggle, anchors:), a class (anchor-panel), a
// verb (anchored, anchoring), and not the command name (cast anchor …).
const WORD = /(?<![\w@#/._:$-])anchors?(?![\w./_:-])/i;
const COMMAND = /cast anchor\b/i;

// What a person reads on a code line: every quoted string with its `${…}`
// code cut out, and JSX text. A bare lowercase token ("anchor", "anchors")
// is a key, a table, a route or an icon name, never a sentence; a bare
// "Anchor" is a name a person sees.
function readable(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    const s = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, " ");
    if (/^\s*\S+\s*$/.test(s) && s.trim() !== "Anchor" && s.trim() !== "Anchors") continue;
    out.push(s);
  }
  for (const m of line.matchAll(/>([^<>{}]+)</g)) out.push(m[1]);
  return out;
}

// Verb sense and page anatomy a person reads correctly: "anchored to this
// line", "Anchor the link at a line". One entry per line, path:line-text.
const ALLOWED: ReadonlyArray<[string, string]> = [
  // A link's #msg-<id> fragment, and a comment pinned to a line: the verb.
  ["packages/cli/src/index.ts", "Anchor the link at a line"],
  ["packages/cli/src/index.ts", "#msg-<id> anchor"],
  ["packages/cli/src/index.ts", "to anchor the exact message"],
  ["packages/cli/src/index.ts", "(no anchor)"],
  ["packages/cli/src/index.ts", "message line to anchor"],
  ["packages/cli/src/prCommand.ts", "Anchor the comment"],
  ["packages/cli/src/prCommand.ts", "anchors nothing"],
  ["packages/web/app/(marketing)/compare/comparisons.ts", "anchor to"],
  ["packages/web/app/(marketing)/compare/comparisons.ts", "anchors a comment"],
  ["packages/convex/convex/githubWebhooks.ts", "const where = comment.path"],
  ["packages/convex/convex/artifactMarkdown.ts", 'class="anchor"'],
  // The analyzer's vocabulary rule names the word so the page never carries it.
  ["packages/cli/src/orgInit.ts", "invented_words"],
  // The team icon set has a boat anchor.
  ["packages/web/components/TeamIcon.tsx", 'anchor: "Anchor"'],
  ["packages/mobile/app/(tabs)/chat.tsx", "anchor: '⚓'"],
  ["packages/mobile/app/(tabs)/tasks.tsx", "anchor: '⚓'"],
];

describe("the word anchor is retired from what a person reads (S22)", () => {
  test("no string a person reads says anchor", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walkSources(root)) {
        const rel = file.slice(REPO.length + 1);
        for (const { line, n } of codeLines(readFileSync(file, "utf8"))) {
          const hit = readable(line).some((s) => WORD.test(s.replace(COMMAND, "")));
          if (!hit) continue;
          if (ALLOWED.some(([f, text]) => rel === f && line.includes(text))) continue;
          offenders.push(`${rel}:${n}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
