import { expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";

// A ghost prune excludes both twins of a session. Reopening it (injectSession)
// puts back the sessions row, and its include lock replaces only the sessions
// exclude. The conversations exclude left behind dropped every meta push, so
// the header said "No machine recorded" for a session running on a teammate's
// box (jx72x09, 2026-11-10).
const state = () => useInboxStore.getState() as any;

// Each test takes its own id: an injected session becomes current, and the
// prune never drops the session on screen.
const seed = (id: string) => {
  state()._setDispatch(async () => null, { owner: {} });
  useInboxStore.setState({
    pending: {},
    sessions: { [id]: { _id: id, title: "Teammate session", updated_at: 1 } } as any,
    conversations: {} as any,
  });
};

test("reopening a pruned session lets its meta load again", () => {
  const ID = "jx7reopenpruned00000000000000000";
  seed(ID);
  state().pruneGhostSessions([ID]);
  expect(state().pending[`conversations:${ID}`]?.type).toBe("exclude");

  state().injectSession({ _id: ID, title: "Teammate session", updated_at: 2, user_id: "u1" });
  state().syncRecord("conversations", ID, { _id: ID, owner_device_id: "dev-1" });

  expect(state().conversations[ID]?.owner_device_id).toBe("dev-1");
  expect(state().pending[`conversations:${ID}`]).toBeUndefined();
});

test("a pruned session that stays out keeps its meta blocked", () => {
  const ID = "jx7prunedstaysout000000000000000";
  seed(ID);
  state().pruneGhostSessions([ID]);
  state().syncRecord("conversations", ID, { _id: ID, owner_device_id: "dev-1" });
  expect(state().conversations[ID]).toBeUndefined();
});
