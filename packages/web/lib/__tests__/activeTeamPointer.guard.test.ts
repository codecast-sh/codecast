import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { walkSources } from "./sourceWalk";
import { join } from "node:path";

// The active team lives in two places ON PURPOSE:
//   • `users.active_team_id` — the CANONICAL pointer. The CLI and mobile read
//     it, so it decides where `cast chat new` puts a channel.
//   • `clientState.ui.active_team_id` — a local MIRROR, so the web UI can
//     re-scope in the same tick instead of awaiting a round trip.
//
// A write to the mirror alone desyncs them, and the symptom appears somewhere
// else entirely: the CLI keeps operating in the team you just left. That is
// exactly what happened at app/settings/team/create — creating a team switched
// the web app and left the pointer behind.
//
// So: every switch goes through hooks/useSwitchWorkspace, which writes both.

const ROOT = join(import.meta.dir, "..", "..");
const DIRS = ["app", "components", "hooks", "lib", "store"];

// The mirror's legitimate writers.
const ALLOWED = new Set([
  "hooks/useSwitchWorkspace.ts", // the sanctioned switch
  "store/inboxStore.ts", // defines updateClientUI and the ui bag
]);

const walk = (dir: string) => walkSources(dir);

describe("active-team pointer", () => {
  test("nothing writes the ui mirror without the canonical pointer", () => {
    const offenders: string[] = [];
    for (const dir of DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = file.slice(ROOT.length + 1);
        if (ALLOWED.has(rel)) continue;
        const src = readFileSync(file, "utf8");
        // A mirror write is `updateClientUI({ ... active_team_id ... })`.
        for (const m of src.matchAll(/updateClientUI\(\{[^}]*active_team_id[^}]*\}/g)) {
          offenders.push(`${rel}: ${m[0].slice(0, 90)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the sanctioned switch writes BOTH halves", () => {
    const src = readFileSync(join(ROOT, "hooks/useSwitchWorkspace.ts"), "utf8");
    expect(src).toContain("updateClientUI({ active_team_id");
    expect(src).toContain("saveActiveTeam");
  });

  // The store's local-first team create is the second sanctioned writer. It
  // moves the mirror in its draft (same tick as the stub row) and rides one
  // dispatch whose server side calls teams.createTeam, which writes the
  // canonical pointer. Both halves must stay in that one action.
  test("the store's createTeam is the only draft writer of the mirror, and its dispatch writes the canonical pointer", () => {
    const store = readFileSync(join(ROOT, "store/inboxStore.ts"), "utf8");
    const writers = [...store.matchAll(/^\s*(\w+):\s*(?:asyncAction|sync|action)\(function[\s\S]*?^ {2}\}\),/gm)]
      .filter((m) => /\.active_team_id = /.test(m[0]))
      .map((m) => m[1]);
    expect(writers.sort()).toEqual(["discardTeamStub", "dispatchCreateTeam", "resolveTeamStub"]);

    const dispatch = readFileSync(
      join(ROOT, "..", "convex", "convex", "dispatch.ts"),
      "utf8",
    );
    const handler = dispatch.match(/^ {2}dispatchCreateTeam: async \([\s\S]*?^ {2}\},/m)?.[0] ?? "";
    expect(handler).toContain("api.teams.createTeam");
    expect(handler).toContain("active_team_id: teamId");

    const teams = readFileSync(join(ROOT, "..", "convex", "convex", "teams.ts"), "utf8");
    const mutation = teams.match(/export const createTeam = mutation\([\s\S]*?^\}\);/m)?.[0] ?? "";
    expect(mutation).toContain("active_team_id: teamId");
  });

  // While the create round trip is in flight the mirror holds the stub id
  // ("team-stub-…"), which is NOT an Id<"teams">: a feeder that hands it to
  // the server raw throws ArgumentValidationError and drops that surface into
  // its ErrorBoundary. The feeders that pass the pointer into query args must
  // therefore guard it with isConvexId (skip, never a personal fallback).
  test("feeders that pass the pointer to the server guard non-Convex ids", () => {
    const guarded = [
      "hooks/useWorkspaceArgs.ts",
      "hooks/useSyncTeamInboxSessions.ts",
      "hooks/useSyncSavedViews.ts",
      "hooks/useConversationsWithError.ts",
      "hooks/useMentionQuery.ts",
      "components/Sidebar.tsx",
      "components/ActivityFeed.tsx",
      "components/TeamAvatarBar.tsx",
      "components/InviteModal.tsx",
    ];
    for (const rel of guarded) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      expect(src, `${rel} must guard the active team id with isConvexId`).toContain("isConvexId(");
    }
  });
});
