#!/usr/bin/env bun
// Gives the review world's sessions the one-line idle summaries the daemon writes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { localDeployment, adminClient } from "../../scripts/rig/stack.mjs";
const world = JSON.parse(readFileSync(join(import.meta.dir, ".seed.json"), "utf8"));
const admin = adminClient(localDeployment());
const lines = [
  "Parser now reads only the receiving server's Authentication-Results; tests on both backends",
  "Sampled 60 review pairs; 41% of findings were acted on",
  "Added the /webhooks/* route and a test that fails on unrouted paths",
  "Worktree ready, screenshots of inbox, a conversation and Tasks taken",
  "Filed the DM routing choice as sd-2654; waiting on the product call",
  "Voice input flushes the last word now; verified on a simulator",
  "Average 11 words a message, no exclamation marks, long answers split",
];
for (const [i, id] of world.conversations.entries()) {
  await admin.mutation("idleSummary:setIdleSummary", { conversation_id: id, idle_summary: lines[i] });
}
console.log("summaries set");
process.exit(0);
