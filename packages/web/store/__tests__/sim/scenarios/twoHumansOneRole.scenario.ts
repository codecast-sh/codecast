// twoHumansOneRole (docs/architecture/multiplayer-sim-harness.md, section 6).
// Two people in one team address the same role 200ms apart, once in each
// order. Every line wakes the role once, the role's hourly wake counter equals
// the wakes (INV-roles), and the role's standing session takes the wakes,
// oldest first, in the order the lines landed in the channel.
//
// Not covered: the sim runs one whole mutation at a time, so two sends racing
// inside Convex's optimistic concurrency never meet here. That half needs the
// disposable deployment recipe in docs/architecture/sync-sim.md.
//
// The standing session is one row in its host's inbox however it arrives:
// the list, byIds and the hire's insert cargo write it the same way
// (INV-fixpoint, INV-row-shape).

import { scenario, type ScenarioWorld } from "../dsl";
import { mentionLine, mentionTarget, mentionWakes } from "../invariantReads";

type Row = Record<string, any>;

// The role's wakes in delivery order (created_at, then insertion) must name
// the channel's lines in channel order. Scripted runs also pin who spoke when.
async function expectTurnOrder(w: ScenarioWorld, role: string, speakers: string[]): Promise<void> {
  await w.settle();
  const [team, handle] = role.slice("role:".length).split("/");
  const rows = (table: string): Row[] => w.backend.db._tables[table] ?? [];
  const byTime = (a: Row, b: Row) => a.created_at - b.created_at || a._creationTime - b._creationTime;
  const named = (ids: unknown[]) => w.labels.relabel(ids.join(" "));
  const wakes = mentionWakes(w).filter((r) => mentionTarget(r) === w.idOf(role));
  const taken = named(wakes.sort(byTime).map(mentionLine));
  const lines = rows("chat_messages").filter((m) => m.channel_id === w.idOf(`chan:${team}/general`) && m.content.includes(`@${handle}`)).sort(byTime);
  const said = lines.map((m) => w.labels.label(String(m.user_id))).join(", ");
  let wrong: string | null = null;
  if (taken !== named(lines.map((m) => m._id))) wrong = `the role takes its wakes for ${taken}, the channel holds ${named(lines.map((m) => m._id))}`;
  else if (w.drainPerVerb && said !== speakers.join(", ")) wrong = `the lines came from ${said}, expected ${speakers.join(", ")}`;
  if (wrong) w.fail({ ...w.reportBase("expect turn order"), invariant: { id: "expect.turnOrder", meaning: `${role} takes its wakes in channel order` }, message: wrong });
}

async function twoHumansOneRole(w: ScenarioWorld): Promise<void> {
  w.team("acme", { features: { chat: true, org: true } });
  w.user("ada", ["acme"]).user("bo", ["acme"]);
  const lead = w.role("acme", "lead");
  const ada = await w.device("ada");
  const bo = await w.device("bo");
  let woken = 0;
  for (const [first, second] of [[ada, bo], [bo, ada]]) {
    await w.human(first.host).tellRole(lead, "can you look at the deploy?");
    await w.advance(200);
    await w.human(second.host).tellRole(lead, "same question from me");
    await w.expect(lead).wokenTimes((woken += 2));
  }
  await expectTurnOrder(w, lead, ["ada", "bo", "bo", "ada"]);
}

scenario({ name: "twoHumansOneRole" }, twoHumansOneRole);
