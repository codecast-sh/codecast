// Two agent sessions in acme answer each other in one thread, each line naming
// the other, for an hour of virtual time (agent-channels.md C2). Must hold:
// agent to agent wakes stay under the hourly mention caps per sender and per
// target (INV-ping-pong), and the net quiesces within the default budget.
//
// Red: after the opening mention every reply reaches the other session through
// the mention-reply relay, which spends only a per-minute limit and never the
// hourly caps, so each session is woken about 30 times in the hour (ct-56047).

import { scenario } from "../dsl";

const ROUNDS = 30;
const HOP_MS = 2 * 60_000;

scenario({ name: "agentPingPong", red: "ct-56047" }, async (w) => {
  w.team("acme", { features: { chat: true } }).user("ada", ["acme"]).user("bo", ["acme"]);
  // Session mentions resolve by short id (`@jx` + 5 characters).
  const ping = w.session("ada", "ping", { agentStatus: "working", row: { short_id: "jxpinga" } });
  const pong = w.session("bo", "pong", { agentStatus: "working", row: { short_id: "jxpongb" } });

  // The opening line is the thread root every reply goes under.
  await w.agent(ping).says("acme/general", "ping", ["jxpongb"]);
  await w.settle();
  const opened = w.actors.log.find((e) => e.actor === `agent.${ping}`);
  if (!opened?.ok) throw new Error(`sim world: agentPingPong's opening line was refused: ${opened?.error}`);
  const thread = w.labels.label(String((opened.result as { message_id: string }).message_id));

  for (let i = 0; i < ROUNDS; i++) {
    await w.agent(pong).says("acme/general", "pong", ["jxpinga"], { thread });
    await w.agent(ping).says("acme/general", "ping", ["jxpongb"], { thread });
    await w.advance(HOP_MS);
  }
});
