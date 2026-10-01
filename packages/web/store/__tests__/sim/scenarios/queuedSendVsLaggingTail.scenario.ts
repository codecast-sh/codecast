// queuedSendVsLaggingTail (docs/architecture/multiplayer-sim-harness.md, section 6):
// ada sends into her working session while her window's transcript tail lags,
// as it did for 33 minutes on 2026-09-23. Her daemon claims, pastes and acks
// the send, so the server holds the echo, and the coverage poll settles the
// bubble while the tail is still behind. The send must render exactly once at
// every point: as the settled bubble while the tail lags, then as its echo
// once the tail lands. INV-pending-sends checks at every settle that each
// client_id is on one pending row and every bubble is echoed, settled or failed.
//
// Red on ct-56011 alone: INV-fixpoint fails every settled window on the
// owned_by_me flap before the scenario's own checks run. With INV-fixpoint left
// out, every default run passes: the send renders once in every order. Sweep
// seed 157409 also fails INV-sessions-mine on a generated anchor (ct-56054).

import { mergeUnconfirmedMessages } from "../../../../hooks/useConversationMessages";
import { scenario, type ScenarioWorld } from "../dsl";
import { windowContext } from "../invariants";
import type { SimWindow } from "../window";

const TEXT = "ship it";

// The send's rows in the transcript the conversation view renders: confirmed rows, then bubbles.
async function expectSendRendersOnce(w: ScenarioWorld, win: SimWindow, session: string, as: "settled bubble" | "echo") {
  const meaning = `${win.name} renders the send to ${session} once, as its ${as}`;
  await w.settleAs(`expect ${meaning}`);
  const id = w.idOf(session);
  const rows = await win.run(() => {
    const s = win.store.getState() as any;
    return mergeUnconfirmedMessages(s.messages[id] ?? [], s.pendingMessages[id] ?? []).filter((m) => m.role === "user" && m.content === TEXT);
  });
  const shape = (m: any) => (m.client_id ? "echo" : m._isSettled ? "settled bubble" : m._isFailed ? "failed bubble" : "bubble in flight");
  const wrong = rows.length !== 1 ? `the send renders ${rows.length} times${rows.length ? ` (${rows.map(shape).join(", ")})` : ""}` : shape(rows[0]) !== as ? `the send renders as its ${shape(rows[0])}` : null;
  if (wrong) w.fail({ ...w.reportBase(), invariant: { id: "expect.sendRendersOnce", meaning }, message: wrong, window: windowContext(win), row: { table: "conversations", id, server: (await w.row(session)) ?? null, replica: rows[0] ?? null } });
}

scenario({ name: "queuedSendVsLaggingTail", red: "ct-56011" }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "working" });
  const a = await w.device("ada");
  const daemon = w.daemon("ada");
  const tail = await a.host.tail(w.idOf(s));
  w.net.lag(tail);

  await w.human(a.host).send(s, TEXT);
  // Interleave runs race the first poll against the send, so the daemon polls
  // twice. No settle between: a send left for the next poll is in flight, which a settle reports.
  for (let poll = 0; poll < 2; poll++) {
    await daemon.claimPending(s);
    await daemon.ack(s);
    await w.net.drain();
  }
  a.host.coverage();
  await expectSendRendersOnce(w, a.host, s, "settled bubble");

  w.net.release(tail);
  await expectSendRendersOnce(w, a.host, s, "echo");
});
