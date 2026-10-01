#!/usr/bin/env bun
/**
 * The daily live check of a cloud agent provider's API (pl-798's canary):
 * one list page and one agent mirrored through the adapter's own read path,
 * so the same shape guard and renderer the watcher uses judge the answers.
 * It reads only, writes nothing, and prints no token or payload.
 *
 *   bun packages/cli/scripts/cloud-agent-canary.ts [provider id, default codex]
 *
 * Its exit code is a trigger precheck's answer, so a healthy day spends nothing:
 *   0  the API changed (a shape break, or an answer it does not expect): run the trigger
 *   1  it read cleanly
 *   2  it could not check (no sign-in, an outage, a limit): nothing to report
 */
import { cloudApiVerdict } from "../src/cloudAgents/apiError.js";
import { cloudAgentAdapters } from "../src/cloudAgents/index.js";
import { CloudShapeError } from "../src/cloudAgents/shape.js";
import { CloudAgentSetupError, errorText, type CloudAgentHandle } from "../src/cloudAgents/types.js";

const CHANGED = 0, CLEAN = 1, UNCHECKED = 2;
const providerId = process.argv[2] ?? "codex";
const adapter = cloudAgentAdapters().find((a) => a.spec.id === providerId);
if (!adapter) {
  console.log(`no cloud agent provider "${providerId}"`);
  process.exit(UNCHECKED);
}

/** Whether a failure means the provider's API changed (what the watcher's kill switch pauses on). */
function changed(err: unknown, listed: boolean): boolean {
  return err instanceof CloudShapeError || cloudApiVerdict(err, { oneAgent: listed, listed }) === "unexpected";
}

function verdict(step: string, err: unknown, listed: boolean): never {
  const broke = changed(err, listed);
  console.log(`${adapter!.spec.label} ${step}: ${broke ? "CHANGED" : "could not check"}: ${errorText(err)}`);
  process.exit(broke ? CHANGED : UNCHECKED);
}

const client = adapter.client();
if (client instanceof CloudAgentSetupError) {
  console.log(`${adapter.spec.label}: could not check: ${client.message}`);
  process.exit(UNCHECKED);
}

let page: Awaited<ReturnType<typeof adapter.listAgents>>;
try {
  page = await adapter.listAgents(client);
} catch (err) {
  verdict("list", err, false);
}
const first = page.items[0];
if (!first) {
  console.log(`${adapter.spec.label}: list read cleanly, no agents to read`);
  process.exit(CLEAN);
}

const handle: CloudAgentHandle<unknown> = {
  agentId: first.id,
  data: () => adapter.loadData(undefined),
  save: () => {},
  notice: async () => undefined,
  scheduleRender: () => {},
  follow: async () => {},
  log: () => {},
};
try {
  const mirrored = await adapter.mirror(client, handle as never, first.agent as never);
  if (!mirrored?.transcript) verdict("mirror", new CloudShapeError("", "a rendered transcript", "none", `${first.id}`), true);
} catch (err) {
  verdict("mirror", err, true);
}
console.log(`${adapter.spec.label}: list and one agent read cleanly`);
process.exit(CLEAN);
