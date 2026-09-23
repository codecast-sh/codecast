// The team feed's own rows: which of the viewer's sessions join the server's
// rows, whose privacy wins when both hold a row, and what the share chip says.
// Run: cd packages/web && bun test lib/__tests__/teamFeedRows.test.ts
import { describe, expect, it } from "bun:test";
import { mergeOwnSessionsIntoTeamFeed, teamShareState } from "../teamFeedRows";
import type { Conversation } from "../../components/ConversationList";

const TEAM = "team1";
const ME = "me";

function row(over: Partial<Conversation>): Conversation {
  return { _id: "x", user_id: "other", started_at: 1, updated_at: 2, duration_ms: 1, is_active: false, author_name: "O", is_own: false, ...over } as Conversation;
}
type S = { _id: string; user_id?: string | null; team_id?: string | null; is_private?: boolean; team_visibility?: string | null; title?: string };
const toConv = (s: S) => row({ _id: s._id, user_id: ME, is_own: true, is_private: s.is_private ?? false, team_visibility: s.team_visibility ?? null, title: s.title });
const merge = (feedRows: Conversation[], sessions: Record<string, S>, keep: (s: S) => boolean = () => true) =>
  mergeOwnSessionsIntoTeamFeed({ feedRows, sessions, teamId: TEAM, viewerId: ME, keep, toConv });

describe("mergeOwnSessionsIntoTeamFeed", () => {
  it("adds the viewer's private sessions for the team, which the server never sends", () => {
    const out = merge([], { a: { _id: "a", user_id: ME, team_id: TEAM, is_private: true, title: "mine" } });
    expect(out.map((c) => [c._id, c.is_own, c.is_private])).toEqual([["a", true, true]]);
  });

  it("keeps the server's row for a session both sets hold, reading privacy from the inbox cache", () => {
    const feed = row({ _id: "a", user_id: ME, is_own: true, is_private: false, team_visibility: "full", subtitle: "server summary" });
    // Hidden from the session header on another device: the inbox cache knows,
    // the feed cache still holds the row the server stopped serving.
    const out = merge([feed], { a: { _id: "a", user_id: ME, team_id: TEAM, is_private: true } });
    expect(out).toHaveLength(1);
    expect(out[0].subtitle).toBe("server summary");
    expect(out[0].is_private).toBe(true);
    // A row whose privacy agrees comes back by reference, so memos hold.
    const same = merge([feed], { a: { _id: "a", user_id: ME, team_id: TEAM, is_private: false } });
    expect(same[0]).toBe(feed);
  });

  it("prefers the server's team level over the inbox cache's optimistic one", () => {
    const feed = row({ _id: "a", user_id: ME, is_own: true, is_private: false, team_visibility: "summary" });
    const out = merge([feed], { a: { _id: "a", user_id: ME, team_id: TEAM, is_private: false, team_visibility: "full" } });
    expect(out[0].team_visibility).toBe("full");
    const noLocal = merge([feed], { a: { _id: "a", user_id: ME, team_id: TEAM, is_private: false } });
    expect(noLocal[0].team_visibility).toBe("summary");
  });

  it("leaves teammates' rows alone and skips sessions of other teams, other authors, and the keep filter", () => {
    const theirs = row({ _id: "t", user_id: "other", is_own: false });
    const out = merge([theirs], {
      t: { _id: "t", user_id: "other", team_id: TEAM, is_private: false },
      b: { _id: "b", user_id: ME, team_id: "team2", is_private: true },
      c: { _id: "c", user_id: "other", team_id: TEAM, is_private: true },
      d: { _id: "d", user_id: ME, team_id: TEAM, is_private: true, title: "sub" },
      e: { _id: "e", user_id: ME, team_id: TEAM, is_private: false },
    }, (s) => s.title !== "sub");
    expect(out[0]).toBe(theirs);
    expect(out.map((c) => c._id)).toEqual(["t", "e"]);
  });
});

describe("teamShareState", () => {
  const summaryMember = { visibility: "summary" as const };
  it("reads a hidden row as private and a shared row at its own level", () => {
    expect(teamShareState({ is_private: true }, summaryMember)).toEqual({ mode: "private", gated: false });
    expect(teamShareState({ is_private: false, team_visibility: "full" }, summaryMember)).toEqual({ mode: "full", gated: false });
    expect(teamShareState({ is_private: false, team_visibility: "summary" }, { visibility: "full" })).toEqual({ mode: "summary", gated: false });
  });
  it("falls back to the member's level for the team when the row sets none", () => {
    expect(teamShareState({ is_private: false }, summaryMember).mode).toBe("summary");
    expect(teamShareState({ is_private: false }, { visibility: "full" }).mode).toBe("full");
    expect(teamShareState({ is_private: false, team_visibility: "private" }, { visibility: "full" }).mode).toBe("full");
  });
  it("reads the level at the session's start when the membership pins the past", () => {
    const m = { visibility: "full" as const, visibility_history: [{ before: 100, visibility: "summary" as const }] };
    expect(teamShareState({ is_private: false, started_at: 50 }, m).mode).toBe("summary");
    expect(teamShareState({ is_private: false, started_at: 150 }, m).mode).toBe("full");
  });
  it("is gated, and private to the team, under a hidden or activity-only membership", () => {
    expect(teamShareState({ is_private: false, team_visibility: "full" }, { visibility: "hidden" })).toEqual({ mode: "private", gated: true });
    expect(teamShareState({ is_private: false }, { visibility: "activity" })).toEqual({ mode: "private", gated: true });
    // No membership row at all reads at the default level, which is shareable.
    expect(teamShareState({ is_private: false }, null)).toEqual({ mode: "summary", gated: false });
  });
});
