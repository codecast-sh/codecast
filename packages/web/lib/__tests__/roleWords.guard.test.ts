import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codeLines, walkSources, WEB_ROOT } from "./sourceWalk";

// One switch, caps hidden as a safety net (docs/architecture/org-staffing.md
// S23.1, S23.2): the words trust stage, understand, decide and direct as
// stages, cap, budget and allowance leave every string a person reads in the
// web app. Like anchorWord.guard.test.ts this reads string literals and JSX
// text, never identifiers or comments, so the stored field and the change
// kinds keep their names while the surfaces speak plainly.

const ROOTS = [join(WEB_ROOT, "app"), join(WEB_ROOT, "components"), join(WEB_ROOT, "lib"), join(WEB_ROOT, "hooks")];

const WORDS: ReadonlyArray<[string, RegExp]> = [
  ["trust", /(?<![\w@#/._:$-])trust(?: stages?| levels?)?(?![\w./_:-])/i],
  // The stage words, in the stage sense only: "at understand", "trust decide", "decide stage", "direct trust".
  // "3 to decide" is a person deciding (S19), not a stage.
  ["stage", /\b(?:at|stage|trust)\s+(?:understand|decide|direct)\b|\b(?:understand|decide|direct)\s+(?:stage|trust)\b/i],
  ["cap", /(?<![\w@#/._:$-])(?:daily )?caps?(?![\w./_:-])/i],
  ["budget", /(?<![\w@#/._:$-])budgets?(?![\w./_:-])/i],
  ["allowance", /(?<![\w@#/._:$-])allowances?(?![\w./_:-])/i],
];

function readable(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    const s = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, " ");
    // A bare token is a key, a class or a data attribute, never a sentence.
    if (/^\s*\S+\s*$/.test(s)) continue;
    out.push(s);
  }
  for (const m of line.matchAll(/>([^<>{}]+)</g)) out.push(m[1]);
  return out;
}

// Another sense of the word, a product outside the org, or a page the org
// words never reach. One entry per line, path:line-text.
const ALLOWED: ReadonlyArray<[string, string]> = [
  // Anthropic's usage windows have a spend cap of their own.
  ["packages/web/components/AccountUsageMeter.tsx", "Extra spend cap reached"],
  ["packages/web/components/AccountUsageMeter.tsx", "extra spend cap reached"],
  // The context panel's sample trigger title is a quoted commit subject.
  ["packages/web/components/TriggerContextPanel.tsx", "budget/cluster fixes"],
  // A third party image origin the reader may or may not trust: the verb.
  ["packages/web/components/tools/MarkdownImages.tsx", "trust"],
  // Team chat's hourly mention limit for agents: a rate, not a role's limit.
  ["packages/web/components/chat/ChatMessage.tsx", "hourly mention cap"],
  ["packages/web/lib/chatMentionWakes.ts", "over the hourly cap"],
];
// A command name (`cast cap`) is not the word.
const COMMAND = /cast cap\b/g;

describe("the org's operating words are retired from what a person reads (S23)", () => {
  test("no string a person reads says trust stage, understand/decide/direct as a stage, cap, budget or allowance", () => {
    const offenders: string[] = [];
    const repo = join(WEB_ROOT, "..", "..");
    for (const root of ROOTS) {
      for (const file of walkSources(root)) {
        // Marketing copy and the dev preview's sample proposals are not the product's surfaces.
        if (file.includes("(marketing)") || /Fixture\.tsx?$/.test(file)) continue;
        const rel = file.slice(repo.length + 1);
        for (const { line, n } of codeLines(readFileSync(file, "utf8"))) {
          // Cheap gate before the quote parse: most lines carry none of the words.
          if (!/trust|understand|decide|direct|cap|budget|allowance/i.test(line)) continue;
          const strings = readable(line.replace(COMMAND, ""));
          const hit = WORDS.find(([, re]) => strings.some((s) => re.test(s)));
          if (!hit) continue;
          if (ALLOWED.some(([f, text]) => rel === f && line.includes(text))) continue;
          offenders.push(`${rel}:${n} [${hit[0]}]: ${line.trim().slice(0, 160)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  }, 120_000);
});
