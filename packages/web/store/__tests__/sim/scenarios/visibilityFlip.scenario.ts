// visibilityFlip (docs/architecture/multiplayer-sim-harness.md, section 6):
// ada shares a private session with acme and takes it back. bo's team slot
// gains the session and loses it again, the task created from it follows the
// session back to private, and INV-sweep (run at every settle) finds no stale
// workspace key.
//
// Known: INV-fixpoint fails every settled window on the owned_by_me flap
// (ct-56011) before any step here can, so the runs leave it out and every
// mode and seed passes; the known check flips once ct-56011 lands.

import { scenario } from "../dsl";

scenario({ name: "visibilityFlip", known: { "INV-fixpoint": "ct-56011" } }, async (w) => {
  w.team("acme");
  w.user("ada", ["acme"]).user("bo", ["acme"]);
  const s = w.session("ada", "s", { private: true });
  const t = w.task("t", { owner: "ada", session: s });
  const ada = await w.device("ada");
  const bo = await w.device("bo", { scope: { team: "acme" } });
  await w.expect(bo.host).hides(s);
  await w.expect("bo").cannotRead(t);

  await w.human(ada.host).setPrivacy(s, "team");
  await w.settle();
  await w.expect(bo.host).shows(s);
  await w.expect.server.row(t).has({ workspace: `team:${w.idOf("acme")}` });

  await w.human(ada.host).setPrivacy(s, "private");
  await w.settle();
  await w.expect(bo.host).hides(s);
  await w.expect("bo").cannotRead(t);
});
