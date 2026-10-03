// Two agent sessions in acme answer each other in one thread, each line naming
// the other, for an hour of virtual time (agent-channels.md C2). Must hold:
// agent to agent wakes stay under the hourly mention caps per sender and per
// target (INV-ping-pong), and the net quiesces within the default budget.
//
// After the opening mention every reply reaches the other session through the
// mention-reply relay. That relay spends the same hourly caps a mention does
// and folds past them, so each sender wakes the other at most
// MENTION_WAKES_PER_SENDER_HOUR times in the hour (ct-56047).
//
// agentPingPongOwnSessions is the same exchange inside one person: a lead
// session names six of its owner's worker sessions in one line and each
// answers. The relay charges each answer to the session that gave it, so the
// owner's own budget, already spent on the six mentions, folds none of them.

import { scenario } from "../dsl";

const ROUNDS = 30;
const HOP_MS = 2 * 60_000;

scenario({ name: "agentPingPong" }, async (w) => {
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

const WORKERS = 6;

scenario({ name: "agentPingPongOwnSessions" }, async (w) => {
  w.team("acme", { features: { chat: true } }).user("ada", ["acme"]);
  const lead = w.session("ada", "lead", { agentStatus: "working", row: { short_id: "jxleadx" } });
  const workers = Array.from({ length: WORKERS }, (_, i) =>
    w.session("ada", `worker${i}`, { agentStatus: "working", row: { short_id: `jxwork${i}` } }));

  await w.agent(lead).says("acme/general", "fan out");
  await w.settle();
  const opened = w.actors.log.find((e) => e.actor === `agent.${lead}`);
  if (!opened?.ok) throw new Error(`sim world: agentPingPongOwnSessions' opening line was refused: ${opened?.error}`);
  const thread = w.labels.label(String((opened.result as { message_id: string }).message_id));

  await w.agent(lead).says("acme/general", "report in", workers.map((_, i) => `jxwork${i}`), { thread });
  await w.settle();
  for (const s of workers) await w.agent(s).says("acme/general", "done", [], { thread });

  const step = "expect every answer reached the lead";
  await w.settleAs(step);
  const answers = w.actors.log.filter((e) => workers.some((s) => e.actor === `agent.${s}`));
  const missed = answers.find((e) => !e.ok || (e.result as { session_relay?: { delivered?: boolean } })?.session_relay?.delivered !== true);
  if (answers.length !== WORKERS || missed) {
    const result = missed?.result as { message_id?: string; session_relay?: { skipped?: string | null } } | undefined;
    w.fail({
      ...w.reportBase(step),
      invariant: { id: "expect.answersRelayed", meaning: "each worker's answer to its lead's mention is relayed to the lead" },
      message: missed
        ? `${missed.actor}'s answer was not relayed: ${missed.ok ? result?.session_relay?.skipped ?? "not delivered" : missed.error}`
        : `${answers.length} answers sent, expected ${WORKERS}`,
      row: { table: "chat_messages", id: String(result?.message_id ?? w.idOf(lead)), server: null, replica: null },
    });
  }
});
