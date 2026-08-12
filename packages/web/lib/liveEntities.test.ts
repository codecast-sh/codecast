import { describe, expect, it } from "bun:test";
import { isForeignSession, findEntityInStore } from "./liveEntities";

// Regression for "dismiss doesn't stick on a session assigned to me": the
// resolver ignored the owner signals, so hideSessionInDraft treated an
// assigned session (run by a teammate, routed to my inbox via session_owners)
// as foreign — dismiss degraded to delete-my-local-copy with no server write,
// and the live inbox subscription re-delivered the row seconds later.
describe("isForeignSession", () => {
  const ME = "users_me";
  const OTHER = "users_other";

  it("a teammate's session with no ownership signal is foreign", () => {
    expect(isForeignSession({ user_id: OTHER }, undefined, ME)).toBe(true);
  });

  it("owned_by_me makes a teammate-run session mine to triage", () => {
    expect(isForeignSession({ user_id: OTHER, owned_by_me: true }, undefined, ME)).toBe(false);
  });

  it("owner_user_id matching me makes it mine", () => {
    expect(isForeignSession({ user_id: OTHER, owner_user_id: ME }, undefined, ME)).toBe(false);
  });

  it("owned_by_me outranks a stale is_own:false meta from a pre-assignment view", () => {
    expect(
      isForeignSession({ user_id: OTHER, owned_by_me: true }, { is_own: false }, ME),
    ).toBe(false);
  });

  it("is_own:false without any owner signal stays foreign", () => {
    expect(isForeignSession({ user_id: OTHER }, { is_own: false }, ME)).toBe(true);
  });

  it("is_own:true is definitive", () => {
    expect(isForeignSession({ user_id: OTHER }, { is_own: true }, ME)).toBe(false);
  });

  it("someone else's owner_user_id does not make it mine", () => {
    expect(isForeignSession({ user_id: OTHER, owner_user_id: OTHER }, undefined, ME)).toBe(true);
  });

  it("my own session is never foreign", () => {
    expect(isForeignSession({ user_id: ME }, undefined, ME)).toBe(false);
  });

  it("thin row with no signals: author_name is the last-resort foreign marker", () => {
    expect(isForeignSession({ author_name: "Samvit" }, undefined, ME)).toBe(true);
    expect(isForeignSession({}, undefined, ME)).toBe(false);
  });
});

// A reference pill (EntityIdPill) shows the object's TITLE. Waiting for the
// Convex round-trip to learn it means every task mention in a conversation
// visibly flips from "ct-38940" to its name on mount. The client normally knows
// the answer already, so the pill seeds itself from the store — this is what it
// has to find.
describe("findEntityInStore", () => {
  const TASK = { _id: "kx1", short_id: "ct-38940", title: "Engine-tick timeouts", status: "in_progress" };
  const OTHER_TEAM_TASK = { _id: "kx2", short_id: "ct-777", title: "Outreach copy", status: "open" };
  const PLAN = { _id: "mx1", short_id: "pl-88", title: "Billing migration", status: "active" };
  const CONV = { _id: "jx7c6zkfhz63vxwbaarvcmrg9h8ca720", short_id: "jx7c6zk", title: "Fork flicker" };

  const state = {
    tasks: { kx1: TASK },
    plans: { mx1: PLAN },
    docs: {},
    projects: {},
    conversations: { [CONV._id]: CONV },
    sessions: {},
    // Cross-team snapshots: the reason a reference to another workspace's task
    // still reads as a name.
    mentionIndex: { tasks: { kx2: OTHER_TEAM_TASK }, plans: {}, docs: {} },
  };

  it("finds a task by short id and by Convex id", () => {
    expect(findEntityInStore(state, "task", "ct-38940")?.title).toBe("Engine-tick timeouts");
    expect(findEntityInStore(state, "task", "kx1")?.title).toBe("Engine-tick timeouts");
  });

  it("is case-insensitive on short ids", () => {
    expect(findEntityInStore(state, "task", "CT-38940")?.title).toBe("Engine-tick timeouts");
  });

  it("falls back to the cross-team mention index", () => {
    // ct-777 belongs to another workspace, so it is not in `tasks` — but the
    // mention index carries it, which is exactly what that index is for.
    expect(findEntityInStore(state, "task", "ct-777")?.title).toBe("Outreach copy");
  });

  it("finds a plan", () => {
    expect(findEntityInStore(state, "plan", "pl-88")?.title).toBe("Billing migration");
  });

  it("finds a session by its 7-char short id, and by its full id", () => {
    expect(findEntityInStore(state, "session", "jx7c6zk")?.title).toBe("Fork flicker");
    expect(findEntityInStore(state, "session", CONV._id)?.title).toBe("Fork flicker");
  });

  it("returns undefined for an object the client has never seen", () => {
    expect(findEntityInStore(state, "task", "ct-99999")).toBeUndefined();
    // Triggers are not a store collection — they always wait for the server.
    expect(findEntityInStore(state, "trigger", "tr-42")).toBeUndefined();
  });

  it("survives a missing or empty state without throwing", () => {
    expect(findEntityInStore(null, "task", "ct-1")).toBeUndefined();
    expect(findEntityInStore({}, "task", "ct-1")).toBeUndefined();
    expect(findEntityInStore(state, "task", "")).toBeUndefined();
  });

  it("reuses one index per collection version, and rebuilds when it changes", () => {
    // The index is memoized on the collection's identity. A pill must not
    // rescan thousands of rows, but it must also never serve a stale answer
    // after the collection is replaced.
    expect(findEntityInStore(state, "task", "ct-38940")?.status).toBe("in_progress");
    const moved = { ...state, tasks: { kx1: { ...TASK, status: "done" } } };
    expect(findEntityInStore(moved, "task", "ct-38940")?.status).toBe("done");
  });
});
