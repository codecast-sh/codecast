// TEMP probe for validation round 18 (sync lens). Deleted after the run.
import { getUndoHistory } from "@platform/engine";
import { scenario } from "../dsl";
const K = { known: { "INV-followers": "ct-56817", "INV-pending-locks": "ct-56817", "INV-sessions-mine": "probe", "INV-fixpoint": "probe" } };
const F = ["inbox_stashed_at", "inbox_dismissed_at", "inbox_stash_hidden", "inbox_pinned_at"];
const dump = async (w: any, win: any, id: string, tag: string) => {
  const out = await win.run(() => {
    const st = win.store.getState();
    const s = st.sessions[id] ?? {};
    const c = st.conversations[id] ?? {};
    const locks = Object.fromEntries(Object.entries(st.pending).filter(([k]) => k.includes(id)));
    const h = getUndoHistory() as any;
    return { s: Object.fromEntries(F.map((f) => [f, s[f]])), c: Object.fromEntries(F.map((f) => [f, c[f]])), locks, hist: JSON.stringify(h, (k, v) => (k === "changes" || k === "args" || k === "planted" ? undefined : v)).slice(0, 1500) };
  });
  console.log(`DUMP ${tag}`, JSON.stringify(out, null, 0));
};
scenario({ name: "r18f_quickA", seeds: 24, modes: ["interleave"], ...K }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  const [f] = a.followers;
  await w.expect(f).shows(s);
  w.human(f).stash(s);
  await w.settle();
  await w.advance(500);
  w.human(f).undo();
  w.advance(120); w.human(f).redo(); w.advance(120); w.human(f).undo();
  await w.settle();
  const id = s;
  const row = await (w as any).row(s);
  console.log("SERVER", JSON.stringify(Object.fromEntries(F.map((k) => [k, row?.[k]]))));
  await dump(w, f, String(row._id), "follower");
  await dump(w, a.host, String(row._id), "host");
  void id;
});
