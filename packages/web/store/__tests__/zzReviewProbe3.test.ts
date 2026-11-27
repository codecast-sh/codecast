import { test } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { makeDispatchBinding } from "../../lib/dispatchBinding";
const st = () => useInboxStore.getState() as any;
const row = (extra: any = {}) => ({ _id: "p1", short_id: "pri-1", title: "P1", status: "active", person_pos: 1, ai_rank: null, last_active_at: 1,
  user_id: "u", workspace: "team:t", mine: true, steps: [{ key: "a", title: "A", done: false, tier: "critical" }], counts: { critical_done: 0, critical_total: 1 }, sessions: [], ...extra });
test("done vs stale push", async () => {
  useInboxStore.setState({ currentUser: { _id: "u" } as any, pending: {}, priorities: {} } as any);
  st()._setDispatch(makeDispatchBinding(() => new Promise(() => {})), { owner: {} });
  st().syncTable("priorities", [row()]);
  st().setPriorityStepDone("pri-1", "a", true);
  await new Promise((r) => setTimeout(r, 0));
  st().syncTable("priorities", [row({ last_active_at: 2 })]);
  const p = st().priorities.p1;
  console.log("RESULT steps done:", p.steps[0].done, "counts:", JSON.stringify(p.counts));
});
