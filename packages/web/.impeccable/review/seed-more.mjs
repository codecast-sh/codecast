#!/usr/bin/env bun
// Adds tasks, docs and a chat channel with messages to the review world.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { localDeployment, adminClient } from "../../scripts/rig/stack.mjs";
const world = JSON.parse(readFileSync(join(import.meta.dir, ".seed.json"), "utf8"));
const dep = localDeployment();
const riley = adminClient(dep, world.riley);
const team = { workspace: "team", team_id: world.teamId };
const tasks = [
  ["Exa trial limits end 29 Oct: extend with Exa or revert People Wiki pacing", "in_progress", "high"],
  ["ChatGPT import: before-GA hardening", "open", "medium"],
  ["Fix sender-authentication parsing on both backends", "in_review", "urgent"],
  ["Route /webhooks/* to the TypeScript backend", "open", "high"],
  ["Mobile: voice input drops the last word", "done", "medium"],
  ["Document the rollout plan for the TS backend", "open", "low"],
  ["Slack bot: answer untagged follow-ups", "in_progress", "medium"],
  ["Audit adversarial review usefulness", "done", "low"],
];
for (const [i, [title, status, priority]] of tasks.entries()) {
  try { await riley.mutation("tasks:webCreate", { title, status, priority, ...team, client_key: `review-task-${i}` }); }
  catch (e) { try { await riley.mutation("tasks:webCreate", { title, priority, ...team, client_key: `review-task-${i}` }); } catch (e2) { console.log("task", e2.message.slice(0, 160)); } }
}
const docs = [
  ["TypeScript backend rollout plan", "## Goal\nMove every route to the TS backend by end of month.\n\n## Steps\n1. Shadow traffic\n2. Webhooks\n3. Cut over"],
  ["Sender authentication: how we parse Authentication-Results", "We trust only the header the receiving server added."],
  ["Mobile voice input: findings", "The recognizer stops on silence before flushing the last word."],
  ["Onboarding checklist for new teammates", "- Install the CLI\n- Run `cast setup`\n- Join #eng"],
  ["Adversarial review: is it worth it?", "41% of findings were acted on."],
];
for (const [i, [title, content]] of docs.entries()) {
  try { await riley.mutation("docs:webCreate", { title, content, ...team }); } catch (e) { console.log("doc", e.message.slice(0, 160)); }
}
try {
  const created = await riley.mutation("chat:createChannel", { team_id: world.teamId, name: "eng", topic: "Engineering: what shipped, what is blocked" });
  const channelId = created?.channel_id ?? created?._id ?? created;
  const msgs = [
    "Webhook routing fix is up as #16123, CI green.",
    "Sender-auth parsing PR is ready for review on both backends.",
    "Heads up: Exa trial limits end on the 29th. Extend or revert pacing?",
    "Voice input fix verified on the simulator, shipping with the next build.",
  ];
  for (const content of msgs) await riley.mutation("chat:sendMessage", { channel_id: channelId, content });
  console.log("channel", String(channelId));
} catch (e) { console.log("chat", e.message.slice(0, 200)); }
console.log("seeded");
process.exit(0);
