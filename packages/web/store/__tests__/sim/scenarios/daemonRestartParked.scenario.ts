// daemonRestartParked (docs/architecture/multiplayer-sim-harness.md, section 6):
// ada's daemon dies with three sessions parked (hibernated) and a trigger
// coming due on one of them, beside one session still working. Its heartbeats
// lapse past the liveness window; it restarts, re-registers the pane that
// survived and claims the trigger. No session may duplicate, the parked rows
// stay parked and read the same in every window (INV-sessions-mine,
// INV-followers), and the armed trigger stays consistent with its session
// (INV-triggers).
//
// Red on ct-56011 alone: INV-fixpoint fails every settled window on the
// owned_by_me flap. With INV-fixpoint left out (runScenario's skipInvariants
// over the exported body), every mode and seed passes, so fixing ct-56011
// flips this scenario.

import { HEARTBEAT_ALIVE_MS } from "@codecast/shared/contracts";
import { scenario, type ScenarioWorld } from "../dsl";
import { daemonDeviceFor } from "../world";

// One managed_sessions row per conversation, and one conversation per session uuid.
async function expectNoDuplicateSessions(w: ScenarioWorld): Promise<void> {
  await w.settleAs("expect no duplicate sessions");
  for (const [table, key] of [["managed_sessions", "conversation_id"], ["conversations", "session_id"]] as const) {
    const seen = new Map<unknown, Record<string, unknown>>();
    for (const row of (w.backend.db._tables[table] ?? []) as Record<string, unknown>[]) {
      const first = seen.get(row[key]);
      if (!first) { seen.set(row[key], row); continue; }
      w.fail({ ...w.reportBase("expect no duplicate sessions"), invariant: { id: "expect.noDuplicateSessions", meaning: `one ${table} row per ${key}` }, message: `two ${table} rows share ${key} ${w.labels.relabel(String(row[key]))}`, row: { table, id: String(row._id), server: row, replica: first } });
    }
  }
}

export async function daemonRestartParked(w: ScenarioWorld): Promise<void> {
  w.team("acme").user("ada", ["acme"]);
  const parked = ["p1", "p2", "p3"].map((n) => w.session("ada", n, { agentStatus: "hibernated" }));
  const live = w.session("ada", "live", { agentStatus: "working" });
  const trigger = w.trigger("nightly", { owner: "ada", session: parked[0] });
  const ada = await w.device("ada", { followers: 1 });
  const daemon = w.daemon("ada");
  // A parked row reads parked whether its daemon is alive, dead or back.
  const stillParked = async () => { for (const s of parked) await w.expect(ada.host).shows(s, { bucket: "dormant" }); };

  await w.advance(HEARTBEAT_ALIVE_MS + 60_000);
  await stillParked();
  // The warm restart re-registers only panes with a live agent; parking killed the others' panes.
  await daemon.restart([live]);
  await daemon.heartbeat(live, "working");
  await daemon.claimTask(trigger);
  await w.expect.server.row(trigger).has({ status: "running", lease_holder: daemonDeviceFor("ada") });
  await w.expect(ada.host).shows(live, { bucket: "working" });
  await stillParked();
  await expectNoDuplicateSessions(w);
}

scenario({ name: "daemonRestartParked", red: "ct-56011" }, daemonRestartParked);
