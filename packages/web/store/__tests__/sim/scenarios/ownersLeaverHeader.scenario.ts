// ownersLeaverHeader: after a leave, the leaver is still looking at the session
// (the header offers the rejoin), and its header follows the server. ada adds
// bo to s, bo leaves, then ada files s under her lead role and adds cy. bo's
// inbox no longer feeds its sessions row for s, but the owners read the
// header mounts still does: the role, the driver and the people bo's header
// draws are the server's.

import { scenario, type ScenarioWorld } from "../dsl";
import { HIDDEN_OVERRIDE_SETTLE_MS } from "../../../inboxOverlays";
import { api } from "@codecast/convex/convex/_generated/api";
import { applyCollectionFeed } from "../../../../hooks/useSyncCollection";
import { selectOwnersRow, feedOwnerFacts } from "../../../../hooks/useOwners";

async function ownersLeaverHeader(w: ScenarioWorld): Promise<void> {
  w.team("acme", { features: { org: true } });
  w.user("ada", ["acme"]).user("bo", ["acme"]).user("cy", ["acme"]);
  const lead = w.role("acme", "lead");
  const s = w.session("ada", "s", { agentStatus: "working" });
  await w.start();
  const sid = w.idOf(s);
  const a = await w.device("ada");
  const b = await w.device("bo");
  const bo = w.idOf("bo");
  const save = (win: any, change: any, inverse: any) => win.run(() => win.store.getState().applySessionOwners(sid, change, inverse));
  for (const win of [a.host, b.host] as any[]) {
    await win.run(() => win.mount("owners", api.sessionOwnership.listOwners, () => ({ session_id: sid }), (d: any) => applyCollectionFeed("sessionOwners", d, selectOwnersRow, undefined, undefined, feedOwnerFacts)));
  }
  const settle = async () => { await w.settle(); await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 1_000); await w.settle(); };
  await w.settle();
  await save(a.host, { add: [bo] }, { remove: [bo] });
  await w.settle();
  // bo has s open, so bo's store keeps it after the leave.
  await b.host.run(() => b.host.store.getState().navigateToSession(sid));
  await save(b.host, { remove: [bo], leave: {} }, { add: [bo] });
  await settle();
  await save(a.host, { role: w.idOf(lead), add: [w.idOf("cy")] }, null);
  await settle();

  const conv: any = await w.backend.db.get(sid as any);
  const server = [conv.org_role_id ?? null, conv.driver_user_id ?? null].map((v) => (v == null ? null : String(v)));
  const st: any = b.host.store.getState();
  const fail = (message: string) => w.fail({
    ...w.reportBase("header"),
    invariant: { id: "expect.leaverHeader", meaning: "the leaver's header shows the session's role and driver as the server has them" },
    message,
  });
  // The header reads the inbox row while bo's store holds it, else the conversation (useOwnersStoreEnv sessionRowOf).
  if (!st.sessions[sid] && !st.conversations[sid]) fail("bo's store holds no row for the session bo has open");
  for (const [twin, row] of [["sessions", st.sessions[sid]], ["conversations", st.conversations[sid]]] as const) {
    if (!row) continue;
    const got = [row.org_role_id ?? null, row.driver_user_id ?? null];
    if (got[0] !== server[0] || got[1] !== server[1]) fail(`bo's ${twin} row has role ${got[0]} driver ${got[1]}, server role ${server[0]} driver ${server[1]}`);
  }
}

scenario({ name: "ownersLeaverHeader", seeds: 2 }, ownersLeaverHeader);
