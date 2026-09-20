import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performCreateProposal, performReviseProposal, performDecideAsk, readProposal } from "./orgProposals";

// Reproduces: decideAsk identifies an ask only by its POSITIONAL INDEX in
// resolveOrgAsks' output. A revise that removes every change of an EARLIER
// ask shifts every later ask's index down. A person who read the page
// before the revise landed, and clicks Accept on what they saw as ask N,
// has that index silently resolve to a DIFFERENT ask once the revise has
// landed server-side — no refusal, no revision check, just a misapplied
// accept on the wrong ask.

const ME = "u".repeat(31) + "m";
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;
const GROWTH = "org_roles_growth";
const S1 = "conversations_analyzer";
const S_GROWTH = "conversations_standing_growth";

function fixtures(extra: Record<string, any[]> = {}) {
  return makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 }],
    teams: [{ _id: TEAM, name: "Acme" }],
    counters: [],
    org_roles: [
      { _id: GROWTH, short_id: "or-1", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Growth lead", handle: "growth", scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", anchor_id: "anchors_growth", created_by: ME, created_at: 1, updated_at: 1 },
    ],
    org_role_history: [],
    anchors: [{ _id: "anchors_growth", name: "Growth lead", scope_type: "team", team_id: TEAM, host_user_id: ME, bot_user_id: ME, org_role_id: GROWTH, conversation_id: S_GROWTH, status: "active" }],
    projects: [], plans: [], tasks: [], docs: [], agent_tasks: [], session_owners: [],
    decision_inbox: [], session_decisions: [], decision_grants: [], org_proposals: [], org_proposal_changes: [],
    conversations: [
      { _id: S1, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude_code", title: "Org analyzer", short_id: "jxanaly", session_id: "s1", project_path: "/repo", updated_at: 1, created_at: 1, message_count: 3 },
      { _id: S_GROWTH, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude_code", title: "Growth lead", short_id: "jxgrowt", session_id: "s_growth", project_path: "/repo/growth", standing_role_id: GROWTH, anchor_id: "anchors_growth", persistent: true, updated_at: 1, created_at: 1, message_count: 0 },
    ],
    ...extra,
  });
}
const ctxOf = (db: any) => ({ db, auth: { getUserIdentity: async () => ({ subject: "browser" }) } }) as any;
const change = (c: any, rationale = "because") => ({ change: c, rationale, evidence: [{ label: "ct-1", href: "/tasks/ct-1" }] });
const spec = (changes: any[], over: Record<string, any> = {}) => ({ title: "Reshape growth", summary_md: "Three asks.", mode: "review", changes, ...over });

describe("decideAsk index stability under revise (review)", () => {
  test("removing all of an earlier ask's changes shifts a later ask's index; a stale accept lands on the wrong ask", async () => {
    const db = fixtures();
    // Three asks: [0] budget on growth (seq 1), [1] trust on growth (seq 2), [2] retire growth (seq 3).
    const r = await performCreateProposal(ctxOf(db), ME as any, {
      team_id: TEAM, from_session: "s1",
      spec: spec(
        [
          change({ kind: "budget", handle: "growth", caps: { wakes_per_day: 12 } }),
          change({ kind: "trust", handle: "growth", trust: "decide" }),
          change({ kind: "retire", handle: "growth" }),
        ],
        { asks: [
          { title: "Raise growth's budget", why: "It hit its cap.", effect: "12 starts a day.", seqs: [1] },
          { title: "Trust growth to decide", why: "It has earned it.", effect: "Fewer confirmations.", seqs: [2] },
          { title: "Retire growth", why: "The area is folding.", effect: "The role and its session end.", seqs: [3] },
        ] },
      ),
    });

    // The person opens the page: index 2 is "Retire growth".
    const rendered = await readProposal(ctxOf(db), ME as any, r.short_id);
    expect(rendered.asks[2].title).toBe("Retire growth");
    expect(rendered.asks[2].seqs).toEqual([3]);

    // Meanwhile the author revises: the budget question is moot, remove seq 1
    // (ask index 0's only change). That empties ask 0, so resolveOrgAsks
    // drops it, and every later ask shifts down by one.
    await performReviseProposal(ctxOf(db), ME as any, { proposal: r.short_id, from_session: "s1", ops: [{ op: "remove", seq: 1 }] });
    const afterRevise = await readProposal(ctxOf(db), ME as any, r.short_id);
    expect(afterRevise.asks.map((a: any) => a.title)).toEqual(["Trust growth to decide", "Retire growth"]);
    // What was index 2 ("Retire growth") is now index 1. "Trust growth to
    // decide" is now index 0, but the reader who is about to click had it at
    // index 1 in their still-rendered page.

    // The person, still looking at their stale render, clicks Accept on
    // what they read as "Trust growth to decide" — sent as ask index 1.
    const out = await performDecideAsk(ctxOf(db), ME as any, { proposal: r.short_id, ask: 1, verdict: "accept", provision: false });

    // BUG: the server has no way to know the person meant "Trust growth to
    // decide" (their stale index 1). It resolves index 1 against the CURRENT
    // array, which is now "Retire growth" — and applies that instead.
    expect(out.title).toBe("Retire growth");
    const role = (await db.query("org_roles").collect()).find((x: any) => x.handle === "growth");
    expect(role.status).toBe("retired"); // growth got retired, though the person meant to accept trust, not retirement.
    const trustSeq2 = (await readProposal(ctxOf(db), ME as any, r.short_id)).changes.find((c: any) => c.seq === 2);
    expect(trustSeq2.status).toBe("proposed"); // "Trust growth to decide" was never touched: silently skipped, not what the person clicked.
  });
});
