// ownersInbox: the owners model (team feature session_owners) across two
// people's devices. Every row in acme is under the model, the generated ones
// included, so INV-sessions-mine compares each window's placements, tally and
// digest with the server's at every settle under the new membership rule.
//
// ada runs four named sessions: her own; one a role started on her account,
// which no person owns; a session her own session spawned, which that session
// owns; and one filed under the lead role that she also owns. Her inbox holds
// the first and the last, and the last waits "With @lead" (working). She adds
// bo to her own session: it joins bo's inbox and stays in hers. She then
// removes herself: it leaves her inbox and stays in bo's.

import { convexIdFor } from "@codecast/shared/contracts/__fixtures__/inboxProjectionGen";
import { userIdFor } from "@codecast/shared/contracts/__fixtures__/teamWorldGen";
import { scenario } from "../dsl";

scenario({ name: "ownersInbox" }, async (w) => {
  w.team("acme", { features: { org: true, session_owners: true } });
  w.user("ada", ["acme"]).user("bo", ["acme"]);
  const own = w.session("ada", "own");
  const roleStarted = w.session("ada", "roleStarted", { row: { role_started: true, org_role_id: convexIdFor("role:lead") } });
  const child = w.session("ada", "child", { row: { spawned_by_conversation_id: convexIdFor("session:ada/own"), agent_name: "worker" } });
  const filed = w.session("ada", "filed", { agentStatus: "idle", row: { org_role_id: convexIdFor("role:lead") } });
  // A child its session owns whose wait escalated to ada (its parent could not
  // answer): hers while the escalation stands, in Needs You.
  const escalated = w.session("ada", "escalated", { agentStatus: "idle", row: { spawned_by_conversation_id: convexIdFor("session:ada/own"), agent_name: "worker", wait_up_at: 1, wait_up_count: 3, wait_up_person: userIdFor("ada") } });
  await w.start();
  await w.clientAs("ada").mutation("sessionOwnership:addSessionOwner", { session_id: w.idOf(filed), owner: w.idOf("ada") });

  const a = await w.device("ada");
  const b = await w.device("bo");
  await w.expect(a.host).shows(own);
  await w.expect(a.host).hides(roleStarted);
  await w.expect(a.host).hides(child);
  await w.expect(a.host).shows(filed, { bucket: "working" });
  await w.expect(a.host).shows(escalated, { bucket: "needs_input" });
  await w.expect(b.host).hides(own);

  // An owner row of her own first, so adding bo keeps her an owner whatever
  // the add does with an implicit starter.
  await w.clientAs("ada").mutation("sessionOwnership:addSessionOwner", { session_id: w.idOf(own), owner: w.idOf("ada") });
  await w.clientAs("ada").mutation("sessionOwnership:addSessionOwner", { session_id: w.idOf(own), owner: w.idOf("bo") });
  await w.settle();
  await w.expect(b.host).shows(own);
  await w.expect(a.host).shows(own);

  await w.clientAs("ada").mutation("sessionOwnership:removeSessionOwner", { session_id: w.idOf(own), owner: w.idOf("ada") });
  await w.settle();
  await w.expect(a.host).hides(own);
  await w.expect(b.host).shows(own);
});

// The same world with the flag off is today's inbox: the runner's rows are
// hers, a spawned session included, and the role's waits are her needs input.
scenario({ name: "ownersInboxFlagOff" }, async (w) => {
  w.team("acme", { features: { org: true } });
  w.user("ada", ["acme"]).user("bo", ["acme"]);
  const own = w.session("ada", "own");
  const roleStarted = w.session("ada", "roleStarted", { row: { role_started: true, org_role_id: convexIdFor("role:lead") } });
  const child = w.session("ada", "child", { row: { spawned_by_conversation_id: convexIdFor("session:ada/own"), agent_name: "worker" } });
  const filed = w.session("ada", "filed", { agentStatus: "idle", row: { org_role_id: convexIdFor("role:lead") } });
  await w.start();
  const a = await w.device("ada");
  const b = await w.device("bo");
  await w.expect(a.host).shows(own);
  await w.expect(a.host).shows(roleStarted);
  await w.expect(a.host).shows(child);
  await w.expect(a.host).shows(filed, { bucket: "needs_input" });
  await w.expect(b.host).hides(own);
});
