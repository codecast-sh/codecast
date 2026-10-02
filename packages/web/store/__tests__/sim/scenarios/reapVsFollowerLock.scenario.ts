// reapVsFollowerLock (docs/architecture/multiplayer-sim-harness.md, section 6):
// ada's follower window kills an empty session (message_count 0) while her
// daemon heartbeats it, so the heartbeat lands while the kill's dispatch is in
// flight. The kill hides the row and queues the teardown; the row itself goes
// with gcEmptyConversations once its 24h grace has passed, fired here as the
// hourly cron fires it. Afterwards the row is gone on the server and from
// every window. The catalog checks the rest at every settle: no lock survives
// (INV-pending-locks) and every cursor equals its head (INV-cursors). The
// host learns the kill twice (the gesture bridge and the follower's
// replicated write) in any order with its acknowledgement, and must hold the
// follower's locks and nothing more (ct-56048).

import { EMPTY_CONVERSATION_GRACE_MS } from "@codecast/convex/convex/cleanup";
import { scenario } from "../dsl";

scenario({ name: "reapVsFollowerLock" }, async (w) => {
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
