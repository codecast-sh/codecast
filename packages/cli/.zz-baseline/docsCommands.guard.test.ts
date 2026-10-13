// Every `cast ...` a design doc tells someone to run names a real command.
//
// Agents read docs/architecture as instructions: a role's standing text is
// written there first and copied into the role. union-ops-role.md told the ops
// role to run `cast app union read` and `cast app union do`, but `cast app`
// drives the codecast app itself and the connector lives under
// `cast connector`, so both calls failed on every wake. Nothing checked the
// words against the CLI, so the doc read as correct.
//
// The words are resolved against the shipped CLI's own tree with the rule the
// prompt dry-run guard uses (unknownCommandWords): a word that leaves the tree
// at the root, or under a group that only answers "unknown command", is
// broken. A word under a leaf or a group that runs something is an argument.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { liveAgentContext, unknownCommandWords } from "./test-helpers/agentContextLive.js";
import type { AgentContext } from "./agentContext.js";

const DOCS = path.resolve(import.meta.dir, "..", "..", "..", "docs", "architecture");

/** Mentions that are not instructions: a record of a removed command, or a
 *  quote of a command an agent invented. Keyed by file, then the words as the
 *  scan reports them. Adding to this list needs the same reason. */
const NOT_INSTRUCTIONS: Record<string, readonly string[]> = {
  // Quotes the commands the org analyzer invented, and says there is no `cast trigger show`.
  "evals-home.md": ["ct show", "pl show", "org roles", "task comments", "trigger show"],
  // `cast escalate` was removed on 2026-09-29; these records keep it as history.
  "org-hire.md": ["escalate", "org template ask"],
  "org-roles-run-work.md": ["escalate"],
  "org-staffing.md": ["escalate", "role name"],
  "org-roles-standing.md": ["role wakes"],
};

/** The leading words of every `cast ...` in a doc: inline code, and lines of a
 *  code block (optionally after a `$ ` prompt). Three words reach every group
 *  depth the CLI has. */
function castMentions(markdown: string): string[] {
  const out: string[] = [];
  for (const m of markdown.matchAll(/(?:`|^\s*(?:\$ )?)cast ([a-z][\w-]*(?: [a-z][\w-]*)*)/gm)) {
    out.push(m[1].split(" ").slice(0, 3).join(" "));
  }
  return out;
}

function brokenMentions(context: AgentContext, file: string, markdown: string): string[] {
  const allowed = NOT_INSTRUCTIONS[file] ?? [];
  const broken = new Set<string>();
  for (const words of castMentions(markdown)) {
    const why = unknownCommandWords(context, words.split(" "));
    if (why && !allowed.some((a) => words === a || words.startsWith(`${a} `))) broken.add(`${file}: \`cast ${words}\`: ${why}`);
  }
  return [...broken];
}

const context = liveAgentContext();

describe("cast commands named in docs/architecture", () => {
  test("the resolver tells a real command from a broken one", () => {
    // Without this, a resolver that stopped seeing the tree would pass every doc.
    expect(unknownCommandWords(context, ["connector", "read", "union"])).toBeNull();
    expect(unknownCommandWords(context, ["connector", "do", "union"])).toBeNull();
    expect(unknownCommandWords(context, ["app", "union", "read"])).toBe("'cast app' has no subcommand 'union'");
    expect(unknownCommandWords(context, ["pl", "show"])).toBe("no command 'pl'");
    // `cast sync <word>` runs the bare command, so the word is an argument.
    expect(unknownCommandWords(context, ["sync", "anything"])).toBeNull();
  });

  test("the scan finds the mentions it exists to check", () => {
    const doc = "Run `cast app union read <reader>`.\n\n```bash\ncast connector do union jobs.rerun --yes\n$ cast events groups\n```\n";
    expect(castMentions(doc)).toEqual(["app union read", "connector do union", "events groups"]);
    expect(brokenMentions(context, "x.md", doc)).toEqual(["x.md: `cast app union read`: 'cast app' has no subcommand 'union'"]);
  });

  test("every mention resolves to a registered command", () => {
    const files = fs.readdirSync(DOCS).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(10);
    const broken = files.flatMap((file) => brokenMentions(context, file, fs.readFileSync(path.join(DOCS, file), "utf-8")));
    expect(broken).toEqual([]);
  });

  test("every allowance still matches a mention, so the list cannot go stale", () => {
    for (const [file, words] of Object.entries(NOT_INSTRUCTIONS)) {
      const mentions = castMentions(fs.readFileSync(path.join(DOCS, file), "utf-8"));
      for (const w of words) expect(mentions.some((m) => m === w || m.startsWith(`${w} `)), `${file}: ${w}`).toBe(true);
    }
  });
});
