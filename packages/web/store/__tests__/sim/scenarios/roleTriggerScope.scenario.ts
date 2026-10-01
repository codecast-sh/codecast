// roleTriggerScope (docs/architecture/multiplayer-sim-harness.md, section 6).
//
// bo's session s is a hand of the role rev. It stops on a permission prompt,
// works on, and stops again at the same message count. That is one ask, so the
// role hears it once: one `session-waits:<s>:<episode>` wake per
// hand_wake_notified_key (agentTasks.routeUpWaitingSession). Both people feed
// their triggers from agentTasks:webList, so INV-triggers holds each replica
// to what webList returns them and every armed_trigger_kind to its triggers.
//
// A literal "waiting" settle schedules no needs-input check
// (managedSessions.scheduleNeedsInputCheck), so the stall is permission_blocked.
//
// Known: INV-fixpoint fails every settled window on the owned_by_me flap
// (ct-56011), so the runs leave it out. The role half then holds in every
// mode and seed of a 20-seed sweep. Red on ct-56051 at interleave seed 114430
// only: INV-sessions-mine, because bo's generated parent bo/g2 has a live
// teammate older than the list window, which lifts it to questions on the
// server only.

import { api } from "@codecast/convex/convex/_generated/api";
import { scenario, type ScenarioWorld } from "../dsl";

export async function roleTriggerScope(w: ScenarioWorld): Promise<void> {
  w.team("acme", { features: { org: true } });
  w.user("ada", ["acme"]).user("bo", ["acme"]);
  const s = w.session("bo", "s", { agentStatus: "working" });
  const rev = w.role("acme", "rev");
  await w.start();
  // bo files s under the role, as the org chart's drag does.
  await w.clientAs("bo").mutation("orgRoles:reparentSession", { conversation_id: w.idOf(s), target: { kind: "role", role_id: w.idOf(rev) } });
  for (const user of ["ada", "bo"]) await (await w.device(user)).host.feed("agentTasks", api.agentTasks.webList, () => ({}));

  const bo = w.daemon("bo");
  await bo.settles(s, "permission_blocked");
  await w.settle();
  await bo.settles(s, "working");
  await w.advance(1_000);
  await w.settle();
  await bo.settles(s, "permission_blocked");
  await w.settle();

  // Every role event about s, keyed by the episode it was fired for.
  const told = (w.backend.db._tables.pending_messages ?? []).map((r: any) => String(r.client_id ?? "")).filter((c: string) => c.startsWith(`session-waits:${w.idOf(s)}:`));
  const key = (await w.row(s))?.hand_wake_notified_key;
  if (told.length !== 1 || told[0] !== `session-waits:${w.idOf(s)}:${key}`) {
    w.fail({ ...w.reportBase("expect role events"), invariant: { id: "expect.roleEvents", meaning: "one role event per hand_wake_notified_key" }, message: `hand_wake_notified_key ${key ?? "(absent)"}, role events [${told.join(", ")}]`, row: { table: "conversations", id: w.idOf(s), server: await w.row(s), replica: null } });
  }
}

scenario({ name: "roleTriggerScope", red: { task: "ct-56051", invariant: "INV-sessions-mine", modes: ["interleave"], seeds: [114430] }, known: { "INV-fixpoint": "ct-56011" } }, roleTriggerScope);
