// viewerHideVsOwner (docs/architecture/multiplayer-sim-harness.md, section 6):
// bo kills ada's team-visible working session from the acme team board while
// ada's daemon settles it. A viewer's kill is a hide of their own board only:
// the server records an inbox_hides row for bo, ada's row keeps its status and
// triage stamps, ada's windows (host and follower) still list it, and bo's
// team slot leaves it out (INV-team-inbox checks the slot at every settle).
//
// Guards ct-56045: when bo's team push lands before bo's inbox floor starts
// (16 of the first 20 interleave seeds, 239423 first), the floor's warm-cache
// probe must leave ada's row alone. byIds serves only rows bo runs or owns, so
// probing it would prune it with a durable exclude and empty bo's team board;
// the probe asks only for ids byIds could return (byIdsCouldReturn). Known:
// INV-fixpoint (ct-56011) is left out, or every run would stop there first.

import { scenario } from "../dsl";

scenario({ name: "viewerHideVsOwner", known: { "INV-fixpoint": "ct-56011" } }, async (w) => {
  w.team("acme");
  w.user("ada", ["acme"]).user("bo", ["acme"]);
  const s = w.session("ada", "s", { agentStatus: "working" });
  const a = await w.device("ada", { followers: 1 });
  const b = await w.device("bo", { scope: { team: "acme" } });
  await w.expect(b.host).shows(s);

  // Scripted runs land the kill, then the settle; interleave runs race them.
  await w.human(b.host).kill(s);
  await w.daemon("ada").settles(s);
  await w.settle();

  // bo's kill is the only inbox_hides insert, so the row is #1 in every order.
  await w.expect.server.row("inbox_hides#1").has({ user_id: w.idOf("bo"), conversation_id: w.idOf(s), kind: "dismiss" });
  await w.expect.server.row(s).has({ status: "active", inbox_dismissed_at: undefined, inbox_killed_at: undefined });
  for (const win of a.windows) await w.expect(win).shows(s);
  await w.expect(b.host).hides(s);
});
