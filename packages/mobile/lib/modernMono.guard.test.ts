// MODERN MONO GUARD.
//
// Under Modern, text sets in Instrument Sans unless its style names a mono
// face (constants/fonts.ts). Classic is mono everywhere, so a code renderer
// that relies on the default face looks right in Classic and turns sans under
// Modern without anyone noticing. Each entry here is a place that draws code,
// a command, a path, a branch, a hash or an id, and the line or style that
// keeps it mono. If one fails, the code-like text there has lost its mono
// face: put `codeFont` (or a Mono face) back, don't delete the entry.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
const MONO = /codeFont|Mono\.\w+|JetBrainsMono-/;

/** A style key's body in a StyleSheet object, on one line or across several. */
function styleBody(src: string, key: string): string | null {
  const one = src.match(new RegExp(`^\\s+${key}: \\{[^\\n]*\\},?$`, "m"));
  if (one) return one[0];
  const many = src.match(new RegExp(`^(\\s+)${key}: \\{\\n([\\s\\S]*?)^\\1\\},?$`, "m"));
  return many ? many[2] : null;
}

/** Style keys that must name a mono face, per file. */
const STYLES: Record<string, string[]> = {
  "components/CastDiff.tsx": ["status", "path", "count", "num", "mark", "code"],
  "components/session/UserRows.tsx": ["bashCommand", "bashOut"],
  "components/session/CastCommandBlock.tsx": ["rawCmd", "rawOut"],
  "components/session/StructuredResultBlock.tsx": ["mono"],
  "components/MarkdownRenderer.tsx": ["refPath"],
  "components/session/NewSessionSheet.tsx": ["folderInput", "folderChipText"],
  "app/session/[id].tsx": ["toolRunText", "toolCallInput", "toolCallResult", "bashPrompt"],
};

/** Lines that must keep naming a mono face where they draw code-like text. */
const LINES: Record<string, Array<[what: string, pattern: RegExp, count?: number]>> = {
  "components/CodeText.tsx": [["highlighted code and ANSI output", /<RNText style=\{\[codeFont, style\]\} selectable>/g, 2]],
  "components/MarkdownRenderer.tsx": [["fenced code lines", /<HighlightedCodeText content=\{line \|\| ' '\} style=\{\{[^}]*fontFamily: 'JetBrainsMono-Regular'/g]],
  "app/session/[id].tsx": [
    ["the branch chip", /style=\{\[styles\.metaChipText, codeFont\]\} numberOfLines=\{1\}>\{conversation\.git_branch\}/g],
    ["a vault secret's name", /style=\{\[styles\.vaultReadyText, codeFont,/g],
    ["a local slash command and its output", /styles\.systemRailText, codeFont,/g, 2],
    ["a trigger's id on a delivery failure", /<RNText style=\{codeFont\}>\{frame\.trigger\}<\/RNText>/g],
    ["slash commands and their arguments", /codeLabel=\{!!(?:cmdName|kind\.cmdName)\}/g, 2],
    ["ids in an escalation caption", /<CodeRuns text=\{caption\} \/>/g],
  ],
  "components/TaskItem.tsx": [["task ids", /\[styles\.(?:shortId|subtaskCount), codeFont\]/g, 2]],
  "components/PlanItem.tsx": [["plan ids", /\[styles\.shortId, codeFont\]\}>\{plan\.short_id\}/g]],
  "components/decisions/QueueMeta.tsx": [["decision ids", /\[styles\.dim, codeFont,/g]],
  "components/session/FlowCard.tsx": [
    ["a run's task id", /\[styles\.task, codeFont,/g, 2],
    ["ids and hashes in the now line", /<CodeRuns text=\{body\} \/>/g],
  ],
  "components/session/CastCommandBlock.tsx": [["vault names, vault commands and a command's target", /\[styles\.summary(?:Text|Muted), codeFont\]/g, 3]],
  "components/session/NewSessionSheet.tsx": [["the machine's name", /code=\{!!selectedDevice\}/g]],
};

describe("code-like text stays mono under Modern", () => {
  for (const [file, keys] of Object.entries(STYLES)) {
    const src = read(file);
    for (const key of keys) {
      test(`${file}: style ${key}`, () => {
        const body = styleBody(src, key);
        expect(body, `${key} not found in ${file}`).not.toBeNull();
        expect(body!).toMatch(MONO);
      });
    }
  }
  for (const [file, lines] of Object.entries(LINES)) {
    const src = read(file);
    for (const [what, pattern, count = 1] of lines) {
      test(`${file}: ${what}`, () => {
        expect(src.match(pattern)?.length ?? 0).toBe(count);
      });
    }
  }
});
