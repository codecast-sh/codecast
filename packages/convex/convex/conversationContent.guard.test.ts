import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A session's team visibility has two rules (privacy.ts):
//   listing  isVisible / isConversationTeamVisible: the session may be LISTED
//            for the team (title, summary, activity).
//   content  contentVisible / canTeamMemberAccess (and everything built on it:
//            checkConversationAccess, canAccessConversation): its messages,
//            prompts, tool calls and file changes may show.
// canTeamMemberAccess fails closed, so a single-session read is safe by
// construction. The way content still leaks is a feed, search or list that
// gates teammates' sessions on the LISTING rule and then reads their
// messages: getMessageFeed did exactly that and served every Summary-level
// teammate's prompts. This test fails any function that reads message
// content behind the listing rule without also asking contentVisible.

const CONTENT_READ = /\.query\(\s*"(messages|file_changes|file_change_bodies)"\s*\)/;
const LISTING_GATE = /\.isVisible\(|\bisConversationTeamVisible\(/;
const CONTENT_GATE = /\.contentVisible\(/;

// Functions that read message rows behind the listing rule but never return
// their text. One line each on why.
const ALLOWED = new Map<string, string>([
  ["conversations.ts:createConversation", "reads a message only to resolve a fork's parent; the listing check gates a title-only activity event"],
  ["conversations.ts:listConversations", "summary and minimal rows return before any preview is read (resolveVisibilityMode); previews reach full rows only"],
]);

function convexSources(): Array<{ file: string; src: string }> {
  const out: Array<{ file: string; src: string }> = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "_generated" || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path, name);
      else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.") && !entry.name.includes(".testkit.")) {
        out.push({ file: name, src: readFileSync(path, "utf8") });
      }
    }
  };
  walk(import.meta.dir, "");
  return out;
}

/** Top-level declarations, each from its line to the next top-level one, with
 *  line comments stripped so prose never counts. */
function topLevelBlocks(src: string): Array<{ name: string; body: string }> {
  const lines = src.split("\n");
  const starts: Array<{ at: number; name: string }> = [];
  const decl = /^(?:export\s+)?(?:const|async function|function)\s+(\w+)/;
  lines.forEach((line, i) => {
    const m = decl.exec(line);
    if (m) starts.push({ at: i, name: m[1] });
  });
  return starts.map((s, i) => ({
    name: s.name,
    body: lines.slice(s.at, starts[i + 1]?.at ?? lines.length).map((l) => l.replace(/\/\/.*$/, "")).join("\n"),
  }));
}

test("no function reads message content behind the listing rule alone", () => {
  const offenders: string[] = [];
  for (const { file, src } of convexSources()) {
    for (const { name, body } of topLevelBlocks(src)) {
      if (!CONTENT_READ.test(body) || !LISTING_GATE.test(body) || CONTENT_GATE.test(body)) continue;
      const key = `${file}:${name}`;
      if (!ALLOWED.has(key)) offenders.push(key);
    }
  }
  expect(offenders).toEqual([]);
});

test("every allowlist entry still names a function that needs it", () => {
  const live = new Set<string>();
  for (const { file, src } of convexSources()) {
    for (const { name, body } of topLevelBlocks(src)) {
      if (CONTENT_READ.test(body) && LISTING_GATE.test(body) && !CONTENT_GATE.test(body)) live.add(`${file}:${name}`);
    }
  }
  expect([...ALLOWED.keys()].filter((k) => !live.has(k))).toEqual([]);
});
