// killUndoRedo (docs/architecture/undo-history.md): a kill taken back and then
// given again, by ⌘⇧Z or by a fresh kill, in a follower window and in a lone
// host. The server stamps inbox_killed_at on the kill, which the kill's draft
// never wrote, so the undo clears it itself. That clear must reach the server
// inside the un-kill it acknowledges: a clear the server drops leaves locks no
// acknowledgement covers, which hold the null over the second kill's stamp, so
// the window shows a killed row as merely dismissed. The catalog checks it at
// every settle: no lock outlives its settle window (INV-pending-locks) and each
// window places the row where the server does (INV-sessions-mine).
//
// The host runs give the kill again in the same tick as the undo, before
// anything comes back from the server. The follower runs settle in between,
// and leave out INV-followers: a follower's late conversations mut leaves the
// host spelling the clear null where the follower holds it absent (ct-56817).

import { HIDDEN_OVERRIDE_SETTLE_MS } from "../../../inboxOverlays";
import { scenario, type ScenarioWorld } from "../dsl";

async function killUndoAgain(w: ScenarioWorld, opts: { follower: boolean; again: "redo" | "kill" }) {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", opts.follower ? { followers: 1 } : {});
  const win = opts.follower ? a.followers[0]! : a.host;
  await w.expect(win).shows(s);

  w.human(win).kill(s);
  await w.settle();
  w.human(win).undo();
  if (opts.follower) {
    await w.settle();
    for (const each of a.windows) await w.expect(each).shows(s);
  }
  if (opts.again === "redo") w.human(win).redo();
  else w.human(win).kill(s);
  await w.settle();
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 60_000);
  await w.settle();
  for (const each of a.windows) await w.expect(each).hides(s);
}

const FOLLOWER_KNOWN = { "INV-followers": "ct-56817" };
scenario({ name: "killUndoRedoFollower", seeds: 3, known: FOLLOWER_KNOWN }, (w) => killUndoAgain(w, { follower: true, again: "redo" }));
scenario({ name: "killUndoRekillFollower", seeds: 3, known: FOLLOWER_KNOWN }, (w) => killUndoAgain(w, { follower: true, again: "kill" }));
scenario({ name: "killUndoRedoQuickHost", seeds: 5 }, (w) => killUndoAgain(w, { follower: false, again: "redo" }));
scenario({ name: "killUndoRekillQuickHost", seeds: 3 }, (w) => killUndoAgain(w, { follower: false, again: "kill" }));
