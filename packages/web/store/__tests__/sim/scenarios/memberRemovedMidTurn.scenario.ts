// memberRemovedMidTurn (docs/architecture/multiplayer-sim-harness.md, section 6):
// ada removes bo from acme while bo's acme board is mid-turn: his window is
// offline, still holds acme sessions, an acme task and the team's anchor, and
// kills one of ada's acme rows before it hears of the removal. Once back
// online the kill reaches the server, which refuses it (bo can no longer read
// the row, so no inbox_hides row is written), and bo's window purges every
// acme row it held. The catalog checks the rest at every settle: no unreadable
// task (INV-workspace-rows), no acme cursor left (INV-cursors), no surviving
// lock or outbox entry, and the anchor list (INV-roles).
//
// Red: every run stops first at INV-fixpoint until ct-56011 lands; with it
// skipped the scenario passes.

import { api } from "@codecast/convex/convex/_generated/api";
import { scenario } from "../dsl";

scenario({ name: "memberRemovedMidTurn", red: "ct-56011" }, async (w) => {
  w.team("acme", { features: { org: true } });
  w.user("ada", ["acme"]).user("bo", ["acme"]);
  const s = w.session("ada", "s");
  w.session("bo", "s", { agentStatus: "working" });
  const t = w.task("t", { owner: "ada", session: s });
  w.role("acme", "rev");
  // bo's team list answers after his first inbox floor. The other order trips
  // ct-56045 (the floor probe prunes team rows), which viewerHideVsOwner guards.
  const teamPush = "live:bo-host:team";
  w.net.lag(teamPush);
  const b = await w.device("bo", { scope: { team: "acme" } });
  w.net.release(teamPush);
  await b.host.bootstrap("tasks", api.tasks.webList, { team_id: w.idOf("acme"), workspace: "team", include_derived: true }, { select: (r: any) => r?.items ?? r });
  await b.host.feed("anchors", api.anchors.listAnchors, () => ({}));
  await w.expect(b.host).shows(s);

  // Interleave mode returns from a verb at once, so the net drains after the
  // removal and after the kill: the removal lands on the server first, and the
  // kill runs in B's window while it still holds s, both while B is offline.
  // A plain drain, not settle(): B holds acme rows it can no longer read until
  // it comes back, which the settle invariants would rightly flag.
  w.net.offline(b.host.name);
  await w.admin("ada").remove("acme", "bo");
  await w.net.drain();
  await w.human(b.host).kill(s);
  await w.net.drain();
  w.net.online(b.host.name);
  await w.settle();

  await w.expect("bo").cannotRead(s);
  await w.expect("bo").cannotRead(t);
  await w.expect(b.host).hides(s);
  await w.expect.server.row(s).has({ inbox_dismissed_at: undefined, inbox_killed_at: undefined });
  // The refused kill wrote no viewer hide for bo.
  const hide = (w.backend.db._tables.inbox_hides ?? []).find((h: any) => h.user_id === w.idOf("bo"));
  if (hide) w.fail({ ...w.reportBase("expect no hide"), invariant: { id: "expect.noHide", meaning: "a refused kill writes no inbox_hides row" }, message: `bo's kill after his removal wrote ${w.labels.label(hide._id)}`, row: { table: "inbox_hides", id: hide._id, server: hide, replica: null } });
});
