import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ONE WORKSPACE PER READ. A read that walks the caller's own memberships
// (team_memberships by_user_id) and merges what it finds reads every team the
// caller belongs to at once: getMessageFeed did that and showed a viewer in
// teams A and B, looking at A, the prompts of B-only members. Session search
// and the CLI feed did the same whenever no team was named.
//
// A read scoped to one workspace resolves its team instead: an explicit,
// membership-proven team, else the active one (resolveInboxTeamScope in
// conversations.ts, activeTeamMembershipFor in lib/access.ts), else personal.
// Session searches and feeds go through resolveReadScope (conversations.ts),
// which walks every membership only when the caller asks for all teams by name
// and then labels each row with its team.
//
// Two rules:
//   1. A public query, mutation or action that walks the caller's memberships
//      is on PUBLIC_CROSS_TEAM, with why it is legitimately cross-team and how
//      its rows say which team each belongs to.
//   2. No function anywhere (helpers included) both walks the caller's
//      memberships and reads sessions (conversations, messages, file changes,
//      a team feed filter) unless it is on SESSION_CROSS_TEAM.

const MEMBERSHIP_WALK = /query\(\s*"team_memberships"\s*\)\s*\.withIndex\(\s*"by_user_id"/;
const PUBLIC_DECL = /=\s*(query|mutation|action|readAction|ensureAction|webTaskAction|cliTaskAction)\s*\(/;
const SESSION_READ = /"conversations"|"messages"|"file_changes"|"file_change_bodies"|createTeamFeedFilter\(/;

const PUBLIC_CROSS_TEAM = new Map<string, string>([
  ["teams.ts:getUserTeams", "the caller's team list itself; every row is a team"],
  ["teams.ts:getUserTeamsV2", "the caller's team list itself; every row is a team"],
  ["users.ts:getTeamsForCLI", "the caller's team list for the CLI; every row is a team"],
  ["threads.ts:unreadByWorkspace", "an unread badge per workspace; each row carries team_id"],
  ["calls.ts:getCallConfig", "which of the caller's teams have calls on; keyed by team id"],
  ["calls.ts:getLiveRooms", "huddles the caller may join in any team; rooms are team-keyed, session titles gated per room"],
  ["anchors.ts:listAnchors", "the workspace agents the caller can reach; each row names its scope and team"],
  ["accountPool.ts:listPool", "shared Claude accounts across the caller's teams; each share carries its team"],
  ["permissionRules.ts:add", "membership check for one named team (filtered to it), not a walk"],
  ["planTemplates.ts:list", "templates the caller can start from; each row carries its team name"],
  ["mods.ts:cliGuide", "shared mods the caller runs; narrowed to the mapped team when a path is given, rows carry team_id"],
  ["liveSearch.ts:search", "live-doc search across workspaces by design; each hit says where it lives"],
  ["pull_requests.ts:getPRsForTimeline", "PRs from the caller's teams for the timeline; rows carry team_id"],
  ["tasks.ts:webList", "the cross-workspace task cache for mention search; rows carry their workspace key"],
  ["tasks.ts:webMentionList", "workspace \"all\" mention list only; rows carry their workspace key"],
  ["docs.ts:webMentionList", "workspace \"all\" mention list only; rows carry their workspace key"],
  ["plans.ts:webMentionList", "workspace \"all\" mention list only; rows carry their workspace key"],
]);

const SESSION_CROSS_TEAM = new Map<string, string>([
  ["conversations.ts:resolveReadScope", "walks every team only on an explicit all-teams ask; rows labelled by workspaceOf/teamNameOf"],
  ["calls.ts:getLiveRooms", "reads a session only for its room title, after the per-room membership check"],
  ["anchors.ts:listAnchors", "reads each anchor's own seat session for its place, not team content"],
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
function topLevelBlocks(src: string): Array<{ name: string; head: string; body: string }> {
  const lines = src.split("\n");
  const starts: Array<{ at: number; name: string }> = [];
  const decl = /^(?:export\s+)?(?:const|async function|function)\s+(\w+)/;
  lines.forEach((line, i) => {
    const m = decl.exec(line);
    if (m) starts.push({ at: i, name: m[1] });
  });
  return starts.map((s, i) => ({
    name: s.name,
    head: lines[s.at],
    body: lines.slice(s.at, starts[i + 1]?.at ?? lines.length).map((l) => l.replace(/\/\/.*$/, "")).join("\n"),
  }));
}

function scan() {
  const publicWalks = new Set<string>();
  const sessionWalks = new Set<string>();
  for (const { file, src } of convexSources()) {
    for (const { name, head, body } of topLevelBlocks(src)) {
      if (!MEMBERSHIP_WALK.test(body)) continue;
      const key = `${file}:${name}`;
      if (PUBLIC_DECL.test(head)) publicWalks.add(key);
      if (SESSION_READ.test(body)) sessionWalks.add(key);
    }
  }
  return { publicWalks, sessionWalks };
}

test("no public function walks the caller's memberships unless it is cross-team by design", () => {
  const { publicWalks } = scan();
  expect([...publicWalks].filter((k) => !PUBLIC_CROSS_TEAM.has(k)).sort()).toEqual([]);
});

test("no function reads sessions across every team the caller belongs to", () => {
  const { sessionWalks } = scan();
  expect([...sessionWalks].filter((k) => !SESSION_CROSS_TEAM.has(k)).sort()).toEqual([]);
});

test("every allowlist entry still names a function that needs it", () => {
  const { publicWalks, sessionWalks } = scan();
  expect([...PUBLIC_CROSS_TEAM.keys()].filter((k) => !publicWalks.has(k))).toEqual([]);
  expect([...SESSION_CROSS_TEAM.keys()].filter((k) => !sessionWalks.has(k))).toEqual([]);
});

test("session search and feed functions read one workspace", () => {
  for (const name of ["searchConversations", "searchConversationTitles", "searchForCLI", "feedForCLI", "getMessageFeed", "loadConversationSearchScope"]) {
    expect(PUBLIC_CROSS_TEAM.has(`conversations.ts:${name}`)).toBe(false);
    expect(SESSION_CROSS_TEAM.has(`conversations.ts:${name}`)).toBe(false);
  }
});
