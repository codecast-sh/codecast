// ownersLeave: leaving a session paints the inbox the way the server will
// answer, and leaves no lock behind for the person who left. ada runs s and a
// run r her lead role started, and adds bo to both. bo's follower leaves s and
// bo's host leaves r (the last person on it, so r is the role's alone again).
// The server sends a receipt only into scopes the caller still holds, and the
// leaver holds neither session's any more, so no acknowledgement reaches the
// leave's locks: the leave's own result releases them, in the window that
// sent it and, over the gesture bridge, in its siblings (INV-pending-locks).
// Then bo rejoins s (the leave's undo) and ada adds bo back to r: bo's rows
// take the server's owners and claim again, with no stale lock overriding them.

import { scenario, type ScenarioWorld } from "../dsl";
import { HIDDEN_OVERRIDE_SETTLE_MS } from "../../../inboxOverlays";
import { api } from "@codecast/convex/convex/_generated/api";
import { applyCollectionFeed } from "../../../../hooks/useSyncCollection";
import { selectOwnersRow, feedOwnerIds } from "../../../../hooks/useOwners";
import { placeInboxRows } from "../../../inboxStore";

async function ownersLeave(w: ScenarioWorld): Promise<void> {
  w.team("acme", { features: { org: true } });
  w.user("ada", ["acme"]).user("bo", ["acme"]);
  const lead = w.role("acme", "lead");
  const s = w.session("ada", "s", { agentStatus: "working" });
  const r = w.session("ada", "r", { agentStatus: "working" });
  await w.start();
  const rid = w.idOf(r);
  const sid = w.idOf(s);
  await w.backend.db.patch(rid, { org_role_id: w.idOf(lead), role_started: true });
  const a = await w.device("ada");
  const b = await w.device("bo", { followers: 1 });
  const bf = b.followers[0]!;
  const bo = w.idOf("bo");
  const save = (win: any, id: string, change: any, inverse: any) => win.run(() => win.store.getState().applySessionOwners(id, change, inverse));
  const mountOwners = (win: any, id: string) => win.run(() => win.mount(`owners-${id}`, api.sessionOwnership.listOwners, () => ({ session_id: id }), (d: any) => applyCollectionFeed("sessionOwners", d, selectOwnersRow, undefined, undefined, feedOwnerIds)));
  for (const id of [sid, rid]) for (const win of [a.host, b.host, bf]) await mountOwners(win, id);
  await w.settle();
  await save(a.host, sid, { add: [bo] }, { remove: [bo] });
  await save(a.host, rid, { add: [bo] }, { remove: [bo] });
  await w.settle();

  const placed = (win: any, id: string) => win.run(() => (placeInboxRows(win.store.getState() as any, { scope: "mine" }).placements.has(id) ? "in" : "out"));
  const expectPlaced = async (win: any, id: string, want: "in" | "out", step: string) => {
    const got = await placed(win, id);
    if (got !== want) w.fail({ ...w.reportBase(step), invariant: { id: "expect.leavePlacement", meaning: "a leave takes the session out of the leaver's inbox at once, and a rejoin puts it back" }, message: `${win.name} places ${w.labels.label(id)} ${got}, expected ${want}` });
  };

  // The leave paints in the window that makes it, before any answer.
  await save(bf, sid, { remove: [bo], leave: {} }, { add: [bo] });
  await save(b.host, rid, { remove: [bo], leave: {} }, { add: [bo] });
  await expectPlaced(bf, sid, "out", "leave painted");
  await expectPlaced(b.host, rid, "out", "leave painted");
  await w.settle();
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 1_000);
  await w.settle();
  for (const win of [b.host, bf]) for (const id of [sid, rid]) await expectPlaced(win, id, "out", "leave settled");

  // bo rejoins s from the follower; ada adds bo back to r.
  await save(bf, sid, { add: [bo] }, null);
  await save(a.host, rid, { add: [bo] }, null);
  await w.settle();
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 1_000);
  await w.settle();
  for (const win of [b.host, bf]) {
    for (const id of [sid, rid]) {
      await expectPlaced(win, id, "in", "back in");
      const row: any = (win.store.getState() as any).sessions[id];
      if (!row?.owned_by_me) w.fail({ ...w.reportBase("back in"), invariant: { id: "expect.claimBack", meaning: "an owner added back claims the session again" }, message: `${win.name} holds ${w.labels.label(id)} with owned_by_me ${row?.owned_by_me}` });
    }
  }
}

scenario({ name: "ownersLeave", seeds: 4 }, ownersLeave);
