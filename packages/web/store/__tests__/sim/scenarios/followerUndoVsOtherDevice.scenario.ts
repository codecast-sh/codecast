// followerUndoVsOtherDevice (docs/architecture/undo-history.md): ada's
// follower window stashes a session and takes the stash back with ⌘Z while
// her second machine stashes the same row again. The follower's undo lock is
// acknowledged at the un-stash's log position; the host then sends the page
// holding the other machine's stash ahead of the cursor that retires that
// lock, so the row lands under the lock first. Retiring the lock must hand
// the follower the stash it hid, or the follower shows the row unstashed
// while the host and the server hold it stashed, until the row changes again.
// The catalog's INV-sessions-mine checks every window against the server at
// each settle; which write the server ends on depends on the run's order.

import { scenario } from "../dsl";

scenario({ name: "followerUndoVsOtherDevice", seeds: 5 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  const other = await w.device("ada");
  const [f] = a.followers;
  await w.expect(f).shows(s);

  w.human(f).stash(s);
  await w.daemon("ada").settles(s);
  await w.settle();
  w.human(f).undo();
  w.human(other.host).stash(s);
  await w.settle();
});
