// reapVsFollowerLock (docs/architecture/multiplayer-sim-harness.md, section 6):
// ada's follower window kills an empty session (message_count 0) while her
// daemon heartbeats it, so the heartbeat lands while the kill's dispatch is in
// flight. The kill hides the row and queues the teardown; the row itself goes
// with gcEmptyConversations once its 24h grace has passed, fired here as the
// hourly cron fires it. Afterwards the row is gone on the server and from
// every window. The catalog checks the rest at every settle: no lock survives
// (INV-pending-locks) and every cursor equals its head (INV-cursors).
//
// Red on ct-56048: the bridged hide plants the three cleared fields the
// follower's own kill never wrote (inbox_pinned_at, inbox_stash_hidden,
// inbox_stashed_at). The follower then holds them where the host does not
// (INV-followers, the scripted run and interleave seed 86035), or the host
// keeps their locks past the settle window (INV-pending-locks, seed 86036).
// Known: INV-fixpoint (ct-56011) is left out, or every run would stop there first.

import { EMPTY_CONVERSATION_GRACE_MS } from "@codecast/convex/convex/cleanup";
import { scenario } from "../dsl";

scenario({ name: "reapVsFollowerLock", red: [{ task: "ct-56048", invariant: "INV-followers" }, { task: "ct-56048", invariant: "INV-pending-locks" }], known: { "INV-fixpoint": "ct-56011" } }, async (w) => {
  w.user("ada");
  // A live pre-warm with nothing in it. _creationTime puts it in gc's window.
  const s = w.session("ada", "s", { agentStatus: "idle", row: { message_count: 0, _creationTime: w.realm.now() - 60_000 } });
  const a = await w.device("ada", { followers: 1 });
  const [f] = a.followers;
  await w.expect(f).shows(s);

  // Not awaited: in scripted runs the heartbeat goes ahead of the kill's dispatch.
  w.human(f).kill(s);
  await w.daemon("ada").heartbeat(s);
  await w.settle();
  for (const win of a.windows) await w.expect(win).hides(s);

  await w.advance(EMPTY_CONVERSATION_GRACE_MS + 30 * 60_000);
  await w.settle();
  w.cron("cleanup:gcEmptyConversations");
  await w.expect.server.gone(s);
  await w.expect("ada").cannotRead(s);
});
