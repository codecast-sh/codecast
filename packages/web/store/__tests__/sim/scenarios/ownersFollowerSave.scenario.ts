// ownersFollowerSave: an owners Save made in a follower window races another
// owner's Save. ada's follower adds cy while bo's host adds eve, so the server's
// answer differs from each paint. The host mirrors the follower's write as a
// lock, and in some orders the follower's acknowledgement reaches the host
// before that write does. The early acknowledgement is kept and given to the
// lock the write plants (earlyAcks), so the lock retires with the receipt and
// every window ends on the server's owners (INV-pending-locks,
// INV-followers). A refused Save (dee is in no team of the session) rolls
// back and leaves no lock.

import { scenario, type ScenarioWorld } from "../dsl";
import { HIDDEN_OVERRIDE_SETTLE_MS } from "../../../inboxOverlays";
import { api } from "@codecast/convex/convex/_generated/api";
import { applyCollectionFeed } from "../../../../hooks/useSyncCollection";
import { selectOwnersRow, feedOwnerFacts } from "../../../../hooks/useOwners";

async function ownersFollowerSave(w: ScenarioWorld): Promise<void> {
  w.team("acme", { features: { org: true } });
  w.user("ada", ["acme"]).user("bo", ["acme"]).user("cy", ["acme"]).user("dee").user("eve", ["acme"]);
  const s = w.session("ada", "s", { agentStatus: "working" });
  const a = await w.device("ada", { followers: 1 }); const af = a.followers[0]!;
  const b = await w.device("bo");
  const c = await w.device("cy");
  const id = w.idOf(s);
  const save = (win: any, change: any, inverse: any) => win.run(() => win.store.getState().applySessionOwners(id, change, inverse));
  const mountOwners = (win: any) => win.run(() => win.mount("owners", api.sessionOwnership.listOwners, () => ({ session_id: id }), (d: any) => applyCollectionFeed("sessionOwners", d, selectOwnersRow, undefined, undefined, feedOwnerFacts)));
  await mountOwners(a.host); await mountOwners(af);
  await w.settle();
  await save(a.host, { add: [w.idOf("bo")] }, { remove: [w.idOf("bo")] });
  await w.settle();
  await mountOwners(b.host);
  await w.settle();
  await save(af, { add: [w.idOf("cy")] }, { remove: [w.idOf("cy")] });
  await save(b.host, { add: [w.idOf("eve")] }, null);
  await w.settle();
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 1_000);
  await w.settle();
  await save(a.host, { add: [w.idOf("dee")] }, { remove: [w.idOf("dee")] });
  await w.settle();

  const row = await w.row(s);
  const owners = (w.backend.db._tables.session_owners ?? []).filter((r: any) => String(r.conversation_id) === id).map((r: any) => String(r.user_id));
  const server = JSON.stringify({ owner_ids: owners, role: row.org_role_id ?? null, driver: row.driver_user_id ?? null });
  for (const win of [a.host, af, b.host, c.host]) {
    const st: any = win.store.getState();
    const r = st.sessions[id];
    if (!r) continue;
    const shown = JSON.stringify({ owner_ids: r.owner_ids, role: r.org_role_id ?? null, driver: r.driver_user_id ?? null });
    const locks = Object.keys(st.pending).filter((k) => k.includes(id));
    if (shown !== server || locks.length) {
      w.fail({ ...w.reportBase("expect owners agree"), invariant: { id: "expect.ownersAgree", meaning: "every window shows the server's owners, role and driver, with no owner lock left" }, message: `${win.name} shows ${w.labels.relabel(shown)} with locks [${locks.join(", ")}], the server holds ${w.labels.relabel(server)}` });
    }
  }
}

scenario({ name: "ownersFollowerSave", seeds: 8 }, ownersFollowerSave);
