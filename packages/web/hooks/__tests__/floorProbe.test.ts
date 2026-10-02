import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { byIdsCouldReturn, inboxFloorFlags, runInboxFloorStep } from "../useSyncInboxSessions";
import { useInboxStore } from "../../store/inboxStore";

// The floor's warm-cache probe re-reads by id the cached rows a complete floor
// did not return, and prunes what byIds omits. byIds admits only the runner or
// an owner (collectInboxSessionsByIds), so a teammate's row the team feeder
// merged into the same cache must never be probed: its omission is not a
// deletion, and pruning it plants a durable exclude that empties the team
// board for good (ct-56045).

const ME = "u_me";
const OTHER = "u_other";
const id = (c: string) => c.repeat(32);
const OWN = id("a");
const OWNED_FOREIGN = id("b");
const TEAMMATE = id("c");
const THIN = id("d");

function row(_id: string, extra: Record<string, unknown>) {
  return { _id, session_id: `s-${_id}`, updated_at: 1, agent_type: "claude_code", message_count: 1, is_idle: false, has_pending: false, ...extra };
}

describe("byIdsCouldReturn", () => {
  test("mirrors byIds' admission: runner or owner, unknown kept", () => {
    expect(byIdsCouldReturn({ user_id: ME }, ME)).toBe(true);
    expect(byIdsCouldReturn({ user_id: OTHER, owned_by_me: true }, ME)).toBe(true);
    expect(byIdsCouldReturn({}, ME)).toBe(true);
    expect(byIdsCouldReturn({ user_id: OTHER }, ME)).toBe(false);
    expect(byIdsCouldReturn({ user_id: OTHER, owned_by_me: false }, ME)).toBe(false);
  });
});

describe("runInboxFloorStep probe", () => {
  test("probes own, owned-foreign and unknown rows, never a teammate's team row", async () => {
    useInboxStore.setState({
      clientStateInitialized: true,
      syncMeta: {},
      syncLogScopeStamps: { [`user:${ME}`]: 1 } as any,
      sessions: {
        [OWN]: row(OWN, { user_id: ME }),
        [OWNED_FOREIGN]: row(OWNED_FOREIGN, { user_id: OTHER, owned_by_me: true }),
        [TEAMMATE]: row(TEAMMATE, { user_id: OTHER }),
        [THIN]: row(THIN, {}),
      } as any,
    });
    let probed: string[] | null = null;
    let done!: () => void;
    const finished = new Promise<void>((r) => { done = r; });
    const convex = {
      query: async (fn: any, args: any) => {
        const name = getFunctionName(fn);
        if (name === "conversations:listInboxSessionsPaginated") {
          // A floor that returns nothing: every probe-eligible cached row is stale.
          return { page: [], isDone: true, continueCursor: "" };
        }
        if (name === "conversations:getInboxSessionsByIds") {
          probed = [...args.ids].sort();
          done();
          // byIds' truth: it serves the rows the caller runs or owns.
          return { sessions: [row(OWN, { user_id: ME }), row(OWNED_FOREIGN, { user_id: OTHER, owned_by_me: true })] };
        }
        throw new Error(`unexpected query ${name}`);
      },
    };
    const flags = inboxFloorFlags(useInboxStore.getState(), ME);
    expect(flags.principalId).toBe(ME);
    runInboxFloorStep(convex as any, flags);
    await finished;
    await new Promise((r) => setTimeout(r, 0));
    expect(probed!).toEqual([OWN, OWNED_FOREIGN, THIN].sort());
    const s = useInboxStore.getState();
    expect(s.sessions[TEAMMATE]).toBeDefined();
    expect(s.sessions[OWN]).toBeDefined();
    expect(s.sessions[OWNED_FOREIGN]).toBeDefined();
  });
});
