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
 *   0  the API changed (a shape break, or an answer it does not expect), or it
 *      has not been able to check for UNCHECKED_ALERT_MS: run the trigger
 *   1  it read cleanly
 *   2  it could not check (no sign-in, an outage, a limit): nothing to report yet
 *
 * A canary that can't check is silent for a while, then says so: the first
 * failed check is kept in ~/.codecast/cloud-agent-canary/<provider>.json, and
 * once checks have failed for UNCHECKED_ALERT_MS the precheck runs the trigger,
 * at most once per that span, until a check gets through.
 */
import * as fs from "fs";
import * as path from "path";
import { defaultConfigDir } from "../src/config/configDir.js";
import { cloudApiVerdict } from "../src/cloudAgents/apiError.js";
import { cloudAgentAdapters } from "../src/cloudAgents/index.js";
import { CloudShapeError } from "../src/cloudAgents/shape.js";
import { CloudAgentSetupError, errorText, type CloudAgentHandle } from "../src/cloudAgents/types.js";

const CHANGED = 0, CLEAN = 1, UNCHECKED = 2;
/** How long the canary may go without a check before the trigger hears of it. */
const UNCHECKED_ALERT_MS = 3 * 24 * 60 * 60_000;
const providerId = process.argv[2] ?? "codex";
const stateFile = path.join(defaultConfigDir(), "cloud-agent-canary", `${providerId}.json`);
const adapter = cloudAgentAdapters().find((a) => a.spec.id === providerId);
if (!adapter) {
  console.log(`no cloud agent provider "${providerId}"`);
  process.exit(UNCHECKED);
}

/** A check got through (clean or changed): the unchecked stretch is over. */
function checked(code: typeof CHANGED | typeof CLEAN): never {
  fs.rmSync(stateFile, { force: true });
  process.exit(code);
}

/**
 * It could not check: quiet, until checks have failed for UNCHECKED_ALERT_MS,
 * then the trigger runs (once per span), with the reason and how long.
 */
function unchecked(line: string): never {
  const now = Date.now();
  let state: { since?: number; alertedAt?: number } = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {}
  const since = typeof state.since === "number" ? state.since : now;
  const days = Math.floor((now - since) / (24 * 60 * 60_000));
  const due = now - since >= UNCHECKED_ALERT_MS && now - (state.alertedAt ?? 0) >= UNCHECKED_ALERT_MS;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateFile, JSON.stringify({ since, ...(due ? { alertedAt: now } : state.alertedAt ? { alertedAt: state.alertedAt } : {}) }), { mode: 0o600 });
  console.log(days > 0 ? `${line} (no check got through for ${days} day${days === 1 ? "" : "s"})` : line);
  process.exit(due ? CHANGED : UNCHECKED);
}

/** Whether a failure means the provider's API changed (what the watcher's kill switch pauses on). */
function changed(err: unknown, listed: boolean): boolean {
  return err instanceof CloudShapeError || cloudApiVerdict(err, { oneAgent: listed, listed }) === "unexpected";
}

function verdict(step: string, err: unknown, listed: boolean): never {
  if (!changed(err, listed)) unchecked(`${adapter!.spec.label} ${step}: could not check: ${errorText(err)}`);
  console.log(`${adapter!.spec.label} ${step}: CHANGED: ${errorText(err)}`);
  checked(CHANGED);
}

const client = adapter.client();
if (client instanceof CloudAgentSetupError) unchecked(`${adapter.spec.label}: could not check: ${client.message}`);

let page: Awaited<ReturnType<typeof adapter.listAgents>>;
try {
  page = await adapter.listAgents(client);
} catch (err) {
  verdict("list", err, false);
}
const first = page.items[0];
if (!first) {
  console.log(`${adapter.spec.label}: list read cleanly, no agents to read`);
  checked(CLEAN);
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
checked(CLEAN);
