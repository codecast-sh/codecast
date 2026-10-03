import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { byIdsMustReturn, inboxFloorFlags, runInboxFloorStep } from "../useSyncInboxSessions";
import { useInboxStore } from "../../store/inboxStore";

// The floor's warm-cache probe re-reads by id the cached rows a complete floor
// did not return, and prunes what byIds omits. byIds must return only the
// rows this principal runs, so only those are probed that way. A teammate's
// row the team feeder merged into the same cache must never be probed: its
// omission is not a deletion, and pruning it plants a durable exclude that
// empties the team board for good (ct-56045). A foreign row whose owned_by_me
// claim went stale (a disown emits nothing to the departed owner) is the same
// row on the team board, so the floor settles it through byIds without a
// prune: a returned row keeps its stamps, an omitted one loses its claim.

const ME = "u_me";
const OTHER = "u_other";
const id = (c: string) => c.repeat(32);
const OWN = id("a");
const OWNED_FOREIGN = id("b");
const TEAMMATE = id("c");
const THIN = id("d");
const STALE_CLAIM = id("e");

function row(_id: string, extra: Record<string, unknown>) {
  return { _id, session_id: `s-${_id}`, updated_at: 1, agent_type: "claude_code", message_count: 1, is_idle: false, has_pending: false, ...extra };
}

describe("byIdsMustReturn", () => {
  test("only the rows the principal runs, unknown kept", () => {
    expect(byIdsMustReturn({ user_id: ME }, ME)).toBe(true);
    expect(byIdsMustReturn({}, ME)).toBe(true);
    expect(byIdsMustReturn({ user_id: OTHER }, ME)).toBe(false);
    expect(byIdsMustReturn({ user_id: OTHER, owned_by_me: true } as any, ME)).toBe(false);
  });
});

describe("runInboxFloorStep probe", () => {
  test("prunes only own and unknown rows; settles claimed foreign rows without a prune; never touches a teammate's team row", async () => {
    useInboxStore.setState({
      clientStateInitialized: true,
      currentUser: { _id: ME } as any,
      syncMeta: {},
      syncLogScopeStamps: { [`user:${ME}`]: 1 } as any,
      sessions: {
        [OWN]: row(OWN, { user_id: ME }),
        [OWNED_FOREIGN]: row(OWNED_FOREIGN, { user_id: OTHER, owned_by_me: true }),
        [TEAMMATE]: row(TEAMMATE, { user_id: OTHER }),
        [THIN]: row(THIN, {}),
        // Team-visible to me, but I was disowned while away: the cached claim is stale.
        [STALE_CLAIM]: row(STALE_CLAIM, { user_id: OTHER, owned_by_me: true }),
      } as any,
    });
    const asked: string[][] = [];
    let done!: () => void;
    const finished = new Promise<void>((r) => { done = r; });
    const convex = {
      query: async (fn: any, args: any) => {
        const name = getFunctionName(fn);
        if (name === "conversations:listInboxSessionsPaginated") {
          // A floor that returns nothing: every cached row is a candidate.
          return { page: [], isDone: true, continueCursor: "" };
        }
        if (name === "conversations:getInboxSessionsByIds") {
          asked.push([...args.ids].sort());
          if (asked.length === 2) done();
          // byIds' truth: it serves the rows the caller runs or still owns.
          const served = [row(OWN, { user_id: ME }), row(OWNED_FOREIGN, { user_id: OTHER, owned_by_me: true })];
          return { sessions: served.filter((r) => args.ids.includes(r._id)) };
        }
        throw new Error(`unexpected query ${name}`);
      },
    };
    const flags = inboxFloorFlags(useInboxStore.getState(), ME);
    expect(flags.principalId).toBe(ME);
    runInboxFloorStep(convex as any, flags);
    await finished;
    await new Promise((r) => setTimeout(r, 0));
    // The pruning probe, then the claim settlement.
    expect(asked).toEqual([[OWN, THIN].sort(), [OWNED_FOREIGN, STALE_CLAIM].sort()]);
    const s = useInboxStore.getState();
    expect(s.sessions[TEAMMATE]).toBeDefined();
    expect(s.sessions[OWN]).toBeDefined();
    expect(s.sessions[OWNED_FOREIGN]?.owned_by_me).toBe(true);
    // Still on my team board, with only its claim cleared.
    expect(s.sessions[STALE_CLAIM]).toBeDefined();
    expect(s.sessions[STALE_CLAIM]?.owned_by_me).toBe(false);
  });
});
