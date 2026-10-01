// resumeVsSend (docs/architecture/multiplayer-sim-harness.md, section 6): ada
// sends to a parked (hibernated) session while a resume of it goes out, once
// in each order: s1 takes the send first, s2 the resume first. A resume
// re-queues stranded rows (resetConversationPendingMessages), so it must not
// hand a send out twice. Her daemon polls, pastes and acks, and polls again.
// Each send is delivered once, its client_id is on one pending row and one
// echoed transcript line, and its bubble settles (INV-pending-sends).
//
// Not covered: a resume landing between a paste and its echo. The daemon's
// `ack` is one delivery (paste, echo, ack), and the real daemon's in-flight
// and injection dedup windows, which guard that gap, are not modelled.
//
// Known: INV-fixpoint fails on the owned_by_me flap (ct-56011), and on the
// echo's title-generation stamp, which reaches the replica through sync-log
// cargo and the next list push removes (ct-56050). Both must go before the
// known check flips. With INV-fixpoint left out every default run passes;
// an order whose last liveness push predates a row's heartbeat deadline
// places it apart from the server (INV-sessions-mine, ct-56054), on no default seed.

import { scenario, type ScenarioWorld } from "../dsl";
import { daemonDeviceFor } from "../world";

type Row = Record<string, any>;

async function expectOneDelivery(w: ScenarioWorld, session: string): Promise<void> {
  await w.settleAs(`expect one delivery into ${session}`);
  const rows = (table: string): Row[] => (w.backend.db._tables[table] ?? []).filter((r: Row) => r.conversation_id === w.idOf(session));
  const sends = rows("pending_messages");
  const claims = (id: string) => w.actors.log.filter((e) => e.verb === "claimPending" && e.ok).flatMap((e) => e.result as string[]).filter((c) => c === id).length;
  const echoes = (cid: string) => rows("messages").filter((m) => m.client_id === cid).length;
  const wrong = sends.length !== 1 ? `${sends.length} pending rows, expected the one send`
    : claims(sends[0]._id) !== 1 ? `the daemon took the send ${claims(sends[0]._id)} times`
    : echoes(sends[0].client_id) !== 1 ? `${echoes(sends[0].client_id)} transcript lines carry its client_id`
    : sends[0].status !== "delivered" ? `the send is ${sends[0].status}` : null;
  if (wrong) w.fail({ ...w.reportBase(), invariant: { id: "expect.oneDelivery", meaning: `one send into ${session}, delivered once` }, message: wrong, row: { table: "pending_messages", id: String(sends[0]?._id ?? w.idOf(session)), server: sends[0] ?? null, replica: null } });
}

export async function resumeVsSend(w: ScenarioWorld): Promise<void> {
  w.user("ada");
  const parked = { agentStatus: "hibernated", row: { owner_device_id: daemonDeviceFor("ada") } } as const;
  const [s1, s2] = [w.session("ada", "s1", parked), w.session("ada", "s2", parked)];
  const ada = await w.device("ada");
  // Each send comes from the open conversation, whose transcript tail retires the bubble on the echo.
  for (const s of [s1, s2]) await ada.host.tail(w.idOf(s));
  const daemon = w.daemon("ada");
  const poll = async () => { await daemon.claimPending(); for (const s of [s1, s2]) await daemon.ack(s); };

  // Scripted runs keep this order; interleave runs race the send, the resume and the poll.
  await w.human(ada.host).send(s1, "pick this up");
  await daemon.resume(s1);
  await daemon.resume(s2);
  await w.human(ada.host).send(s2, "pick this up");
  await poll();
  // No settle here: a send the race left for the next poll is in flight, which a settle reports.
  await w.net.drain();
  await poll();
  await poll();
  for (const s of [s1, s2]) await expectOneDelivery(w, s);
}

scenario({ name: "resumeVsSend", known: { "INV-fixpoint": ["ct-56011", "ct-56050"] } }, resumeVsSend);
