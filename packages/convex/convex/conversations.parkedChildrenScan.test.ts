import { describe, expect, test } from "bun:test";
import { computeInboxSessions } from "./conversations";
import { makeFakeDb } from "./testDb";

// listInboxSessions timed out with "too many system operations": the full
// enrichment ran a by_parent_conversation_id children scan for EVERY shown row,
// and on a heavy account most shown rows are parked (dismissed/stashed) triage
// rows — 483 of 547 on the census that hit the timeout. A parked parent's
// subagent children are discarded by every caller, and the "producing child
// keeps parent working" refinement is deliberately never applied to parked rows
// (matching the sessionsLiveness overlay, whose value wins on the client), so
// those scans bought nothing. These tests pin: parked rows skip the scan, their
// implementation-session pointer still resolves from the candidate pool, and
// active rows keep the scan plus child emission.
describe("parked rows skip the per-row children scan", () => {
  const ME = "users_me";
  const H = 60 * 60 * 1000;
  const NOW = Date.now();

  function fixtures() {
    const db = makeFakeDb({
      users: [{ _id: ME, name: "Me", email: "me@example.com" }],
      conversations: [
        // Active parent with a producing subagent child — the scan must still run
        // here so the child row is emitted under it.
        { _id: "conversations_active", user_id: ME, status: "active", updated_at: NOW, started_at: NOW - H, message_count: 3, last_message_role: "assistant" },
        // Stashed parent with its own subagent child: no scan, child never emitted.
        { _id: "conversations_stashed", user_id: ME, status: "active", updated_at: NOW - H, started_at: NOW - 2 * H, message_count: 3, last_message_role: "assistant", inbox_stashed_at: NOW - H },
        // Dismissed plan session whose plan-handoff child is in the recent
        // window — the implementation_session chip must survive the skipped scan.
        { _id: "conversations_plan", user_id: ME, status: "active", updated_at: NOW - 2 * H, started_at: NOW - 3 * H, message_count: 5, last_message_role: "assistant", inbox_dismissed_at: NOW - 2 * H },
        { _id: "conversations_impl", user_id: ME, status: "active", updated_at: NOW, started_at: NOW - H, message_count: 1, last_message_role: "assistant", is_subagent: false, parent_conversation_id: "conversations_plan", parent_message_uuid: "plan-handoff", title: "Implement the plan" },
        // Subagent children (excluded from the top-level windows at the index).
        { _id: "conversations_sub_active", user_id: ME, status: "active", updated_at: NOW, started_at: NOW, message_count: 2, is_subagent: true, parent_conversation_id: "conversations_active" },
        { _id: "conversations_sub_stashed", user_id: ME, status: "active", updated_at: NOW, started_at: NOW, message_count: 2, is_subagent: true, parent_conversation_id: "conversations_stashed" },
      ],
      session_owners: [],
      managed_sessions: [],
      messages: [],
    });
    // Count children scans by index name. The fake builder discards the name,
    // so intercept withIndex on the way in.
    const childScanParents: string[] = [];
    const origQuery = db.query.bind(db);
    db.query = (table: string) => {
      const builder = origQuery(table);
      const origWithIndex = builder.withIndex.bind(builder);
      builder.withIndex = (name: string, fn?: (q: any) => any) => {
        if (name === "by_parent_conversation_id") {
          fn?.({ eq: (_f: string, v: any) => { childScanParents.push(String(v)); } } as any);
        }
        return origWithIndex(name, fn);
      };
      return builder;
    };
    return { db, childScanParents };
  }

  test("children scans run only for unparked rows; parked children stay unemitted", async () => {
    const { db, childScanParents } = fixtures();
    const { sessions } = await computeInboxSessions({ db }, ME as any, { show_all: false });
    // Only the active parent and the impl child (both unparked, message_count>0)
    // scan for children — never the stashed or dismissed parents.
    expect(childScanParents.sort()).toEqual(["conversations_active", "conversations_impl"]);
    const ids = sessions.map((s: any) => s._id.toString());
    expect(ids).toContain("conversations_sub_active"); // emitted under the active parent
    expect(ids).not.toContain("conversations_sub_stashed"); // parked parent: children discarded
  });

  test("a parked plan session keeps its implementation-session pointer via the pool", async () => {
    const { db } = fixtures();
    const { sessions } = await computeInboxSessions({ db }, ME as any, { show_all: false });
    const plan = sessions.find((s: any) => s._id.toString() === "conversations_plan");
    expect(plan?.implementation_session).toEqual({ _id: "conversations_impl", title: "Implement the plan" });
  });

  test("a producing subagent child no longer holds a stashed parent in working", async () => {
    const { db } = fixtures();
    // includeLiveness defaults true (the CLI path). The stashed parent's fresh
    // subagent child used to flip is_idle back to false; the overlay never did,
    // so the two channels disagreed. Both now report the parked row as settled.
    const { sessions } = await computeInboxSessions({ db }, ME as any, { show_all: false });
    const stashed = sessions.find((s: any) => s._id.toString() === "conversations_stashed");
    expect(stashed?.is_idle).toBe(true);
  });
});
