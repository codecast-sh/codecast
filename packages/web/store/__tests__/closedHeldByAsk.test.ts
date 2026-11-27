import { describe, expect, test } from "bun:test";
import { __resetInboxPlacementCacheForTests, placeInboxRows, type InboxSession } from "../inboxStore";
import { placeSections } from "./placeTestHarness";

// Close hides a session until it needs you; one whose agent waits on a prompt
// needs you now (shared closeHeldByAsk). The web and the phone place rows
// through placeInboxRows, so the close marker has to reach the shared rule
// there too, and a held close files where it is placed, not under Closed.
const NOW = Date.now();
const AT = NOW - 60_000;

const row = (id: string, extra: Record<string, unknown>) =>
  ({ _id: id, session_id: `s-${id}`, title: id, agent_type: "claude_code", message_count: 8, updated_at: NOW - 5_000, last_heartbeat: NOW - 1000, ...extra }) as InboxSession;

// A close set aside on a prompt, and a teammate's close (dismiss shape: the agent kept running).
const asideOnPrompt = row("aside", { inbox_closed_at: AT, inbox_stashed_at: AT, inbox_stash_hidden: true, agent_status: "permission_blocked" });
const teamOnPrompt = row("team", { inbox_closed_at: AT, inbox_dismissed_at: AT, agent_status: "permission_blocked" });
const ids = (rs: InboxSession[]) => rs.map((s) => s._id);

describe("a closed session waiting on a prompt stays in view on web and phone", () => {
  test("it files as a question, not under Stashed or Closed", () => {
    const placed = placeSections({ aside: asideOnPrompt, team: teamOnPrompt }, new Set(), new Set(), { now: NOW });
    expect(placed.placements.get("aside")?.bucket).toBe("questions");
    expect(placed.placements.get("team")?.bucket).toBe("questions");
    expect(ids(placed.questions).sort()).toEqual(["aside", "team"]);
    expect(ids(placed.stashed)).toEqual([]);
    expect(ids(placed.dismissed)).toEqual([]);
  });

  test("once the ask is answered the close holds again", () => {
    const placed = placeSections({
      aside: { ...asideOnPrompt, agent_status: "working" },
      team: { ...teamOnPrompt, agent_status: "stopped" },
    }, new Set(), new Set(), { now: NOW });
    expect(ids(placed.stashed)).toEqual(["aside"]);
    expect(ids(placed.dismissed)).toEqual(["team"]);
  });

  test("a held close the Closed shelf paged in is not listed under Closed as well", () => {
    __resetInboxPlacementCacheForTests();
    const id = "t".repeat(32);
    const placed = placeInboxRows({
      sessions: { [id]: { ...teamOnPrompt, _id: id } },
      sessionsWithQueuedMessages: new Set(), pendingMessages: {}, pendingSessionCreates: {}, blockedReviveRequestedAt: {},
      clientState: { ui: { inbox_show_old: true, inbox_scope: "mine" } }, currentUser: null, currentSessionId: null,
      killedShelf: { ids: [id] },
    } as any, { now: NOW });
    expect(ids(placed.questions)).toEqual([id]);
    expect(ids(placed.dismissed)).toEqual([]);
  });

  test("a person's own stash over a prompt keeps hiding it", () => {
    const placed = placeSections({ stash: row("stash", { inbox_stashed_at: AT, inbox_stash_hidden: true, agent_status: "permission_blocked" }) }, new Set(), new Set(), { now: NOW });
    expect(ids(placed.stashed)).toEqual(["stash"]);
  });
});
