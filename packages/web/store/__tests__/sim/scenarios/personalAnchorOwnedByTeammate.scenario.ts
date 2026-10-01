// personalAnchorOwnedByTeammate (docs/architecture/multiplayer-sim-harness.md,
// section 6): ada's personal standing session (private, persistent) is handed
// to her teammate bo as a second owner (session_owners), through the mutation
// `cast own` and the owners picker call. bo triages it from his own inbox: a
// pin, then a kill. The server accepts both (dispatch lets every owner
// triage), and bo's ack must retire bo's locks: once the clock passes the
// settle window, INV-pending-locks fails any lock bo still holds.
//
// Red on ct-56044 (INV-pending-locks, every run): a conversation's sync-log
// actions fan out to its runner's scope only (changeLog.scopeFromDoc reads
// user_id; syncLog.scopesForChange), so bo's locks carry acks in
// user:<ada>, a scope bo never holds, and never retire. Known: INV-fixpoint
// (ct-56011) is left out, or every run would stop there first.

import { HIDDEN_OVERRIDE_SETTLE_MS } from "../../../inboxOverlays";
import { scenario } from "../dsl";

scenario({ name: "personalAnchorOwnedByTeammate", red: { task: "ct-56044", invariant: "INV-pending-locks" }, known: { "INV-fixpoint": "ct-56011" } }, async (w) => {
  w.team("acme");
  w.user("ada", ["acme"]).user("bo", ["acme"]);
  const s = w.session("ada", "anchor", { private: true, row: { persistent: true } });
  await w.start();
  await w.clientAs("ada").mutation("sessionOwnership:addSessionOwner", { session_id: w.idOf(s), owner: w.idOf("bo") });
  await w.device("ada");
  const b = await w.device("bo");
  await w.expect(b.host).shows(s);

  await w.human(b.host).pin(s);
  await w.human(b.host).kill(s);
  // Both gestures land in every order before the clock moves past the settle window.
  await w.settle();
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 1_000);
  await w.settle();
});
