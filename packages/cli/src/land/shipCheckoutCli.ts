// `cast ship checkout`: the terminal face of land/shipCheckout.ts. Loaded
// lazily by shipCommand.ts so `cast ship run` stays as light as it was.

import * as fs from "node:fs";
import * as path from "node:path";
import { fmt } from "../colors.js";
import { formatAgeShort } from "../publishCommand.js";
import { git } from "../wipSnapshot.js";
import { inboxRoster } from "./cli.js";
import { makePlan, planPath, runPlan, shipSpec, type ShipGroup, type ShipOutcome, type ShipPlan } from "./shipCheckout.js";

export interface CheckoutOptions {
  plan?: string | boolean;
  dryRun?: boolean;
  json?: boolean;
  check?: boolean;
  push?: boolean;
  deploy?: boolean;
  fetch?: boolean;
  /** Comma-separated groups to ship; every other group is held. */
  only?: string;
  /** Comma-separated groups to hold. */
  hold?: string;
  /** Hold every group: ship only the checkout's own unpushed commits. */
  commitsOnly?: boolean;
  /** `<group>=<message>`, repeatable. */
  message?: string[];
}

/** The group a name means: its id, a session's short id without the `s:`, or a unique prefix of either. */
function groupNamed(plan: ShipPlan, name: string): ShipGroup {
  const want = name.trim();
  const exact = plan.groups.find((g) => g.id === want || g.id === `s:${want}`);
  if (exact) return exact;
  const prefixed = plan.groups.filter((g) => g.id.startsWith(want) || g.id.startsWith(`s:${want}`));
  if (prefixed.length === 1) return prefixed[0];
  const ids = plan.groups.map((g) => g.id).join(", ") || "none";
  throw new Error(prefixed.length ? `"${want}" names ${prefixed.length} groups (${prefixed.map((g) => g.id).join(", ")}): give more of it` : `No group "${want}" in the plan; its groups: ${ids}`);
}

const names = (list?: string) => (list ?? "").split(",").map((n) => n.trim()).filter(Boolean);

/**
 * The plan as the flags steer it: which groups ship, and their messages. Each
 * flag is what an agent otherwise did by rewriting ship-plan.json by hand.
 * Returns whether anything changed, so the file is rewritten only then.
 */
export function steerPlan(plan: ShipPlan, o: Pick<CheckoutOptions, "only" | "hold" | "commitsOnly" | "message">): boolean {
  if (o.commitsOnly && o.only) throw new Error("--commits-only holds every group, so it takes no --only");
  let changed = false;
  const set = (g: ShipGroup, ship: boolean) => { if (g.ship !== ship) { g.ship = ship; changed = true; } };
  if (o.only !== undefined) {
    const keep = new Set(names(o.only).map((n) => groupNamed(plan, n)));
    if (!keep.size) throw new Error("--only takes group names: --only s:jx7abc1,unattributed");
    for (const g of plan.groups) set(g, keep.has(g));
  }
  if (o.commitsOnly) for (const g of plan.groups) set(g, false);
  for (const n of names(o.hold)) set(groupNamed(plan, n), false);
  for (const spec of o.message ?? []) {
    const at = spec.indexOf("=");
    if (at <= 0 || !spec.slice(at + 1).trim()) throw new Error(`--message takes <group>=<message>, like s:jx7abc1="fix(cli): keep acronyms" (got "${spec}")`);
    const g = groupNamed(plan, spec.slice(0, at));
    const text = spec.slice(at + 1).trim();
    if (g.message !== text) { g.message = text; changed = true; }
  }
  return changed;
}

const log = (line: string) => console.error(fmt.muted(`· ${line}`));

export function formatPlan(plan: ShipPlan, file: string): string {
  const out: string[] = [];
  const shipping = plan.groups.filter((g) => g.ship);
  const files = shipping.reduce((n, g) => n + g.paths.length, 0);
  out.push(`${fmt.highlight("Ship plan")} ${fmt.muted(`${plan.mode} to ${plan.upstream}, frozen ${plan.tree.slice(0, 9)} on ${plan.base.slice(0, 9)}`)}`);
  out.push(`  ${files} file(s) in ${shipping.length} commit(s); attributed ${plan.attribution.attributed}/${plan.attribution.files}${plan.behind ? `; ${plan.behind} upstream commit(s) to replay onto` : ""}`);
  if (plan.local_commits.length) {
    out.push(`  ${plan.local_commits.length} local commit(s) ship first:`);
    for (const c of plan.local_commits) out.push(`    ${fmt.muted(c.sha.slice(0, 9))} ${c.subject}`);
  }
  for (const g of plan.groups) {
    const s = g.session;
    const who = s ? `${s.title ?? fmt.muted("(no title)")}` : g.id === "unattributed" ? fmt.muted("no session's edit names these") : "";
    const state = s?.mid_turn ? fmt.warning(" MID-TURN") : s?.state ? fmt.muted(` ${s.state}`) : "";
    const mark = g.ship ? fmt.success("ship") : fmt.warning("hold");
    out.push("");
    const ago = g.last_edit ? formatAgeShort(Date.parse(plan.created_at) - Date.parse(g.last_edit)) : null;
    const age = ago ? `, last edit ${ago === "now" ? "under a minute" : ago} before the freeze` : "";
    out.push(`  ${mark} ${fmt.highlight(g.id)} ${who}${state} ${fmt.muted(`${g.stat.files} files +${g.stat.added} -${g.stat.removed}${age}`)}`);
    if (g.ship) out.push(`       ${g.message}`);
    if (g.note) out.push(`       ${fmt.warning(g.note)}`);
    if (s?.mid_turn && s.last_text) out.push(`       ${fmt.muted(`last said: ${s.last_text.replace(/\s+/g, " ").slice(0, 200)}`)}`);
    const shown = g.paths.slice(0, 6);
    out.push(`       ${fmt.muted(shown.join(", ") + (g.paths.length > shown.length ? `, +${g.paths.length - shown.length} more` : ""))}`);
  }
  out.push("");
  out.push(fmt.muted(`Plan written to ${file}. Steer it with --hold <group>, --only <group>, --commits-only or --message <group>=<text> (on --plan too); move paths between groups in the file; then: cast ship checkout --plan`));
  return out.join("\n");
}

function formatOutcome(r: ShipOutcome): string {
  const out: string[] = [];
  out.push(r.ok ? `${fmt.success("✓")} Shipped${r.pr ? ` as ${r.pr}` : r.pushed ? ` ${r.pushed.slice(0, 9)}` : ""}` : `${fmt.error("✗")} Stopped at ${r.stage}: ${r.reason ?? ""}`);
  for (const c of r.commits) out.push(`  ${fmt.muted(c.sha.slice(0, 9))} ${c.message} ${fmt.muted(`(${c.files})`)}`);
  if (r.ok && r.reason) out.push(fmt.muted(`  ${r.reason}`));
  for (const h of r.held) out.push(`  ${fmt.warning("held")} ${h.group}: ${h.paths.length} file(s)`);
  for (const d of r.deploys) out.push(`  ${d.ok ? fmt.success("deployed") : fmt.error("deploy failed")} ${d.name}`);
  if (r.check?.ignored?.length) out.push(fmt.muted(`  check: ${r.check.ignored.length} error(s) ignored in files left out of this ship`));
  if (!r.ok && r.check?.output) out.push(r.check.output.split("\n").slice(-40).join("\n"));
  if (r.level && r.level.conflicts.length) out.push(`  ${fmt.warning("level")}: ${r.level.conflicts.join(", ")}`);
  return out.join("\n");
}

/**
 * The pass as codecast records it (deploys.md DP11): its commits with the session that wrote each, the groups it
 * held back, each deploy step's result. The server records a deploy for every step that names a target.
 */
export function shipPassBody(plan: ShipPlan, r: ShipOutcome, repository: string, startedAt: number, deviceId?: string): Record<string, unknown> {
  const sessions = new Map(plan.groups.map((g) => [g.id, g.session] as const));
  return {
    repository,
    ...(deviceId ? { device_id: deviceId } : {}),
    ok: r.ok,
    stage: r.stage,
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.base ? { base: r.base } : {}),
    ...(r.tip ? { tip: r.tip } : {}),
    ...(r.pushed ? { pushed: r.pushed } : {}),
    ...(r.pr ? { pr_url: r.pr } : {}),
    commits: r.commits.map((c) => {
      const s = sessions.get(c.group);
      return { sha: c.sha, message: c.message, files: c.files, ...(s?.id ? { session_id: s.id } : {}), ...(s?.conversation_id ? { conversation_id: s.conversation_id } : {}) };
    }),
    held: r.held.map((h) => ({ group: h.group, paths: h.paths.length, ...(h.note ? { note: h.note } : {}) })),
    deploys: r.deploys.map((d) => ({ name: d.name, stage: d.stage, ok: d.ok, ...(d.target ? { target: d.target } : {}), ...(d.dirty ? { dirty: d.dirty } : {}), ...(d.output ? { output: d.output.slice(-3000) } : {}) })),
    started_at: startedAt,
  };
}

export async function runCheckoutCommand(opts: CheckoutOptions, record?: (body: Record<string, unknown>) => Promise<any>): Promise<void> {
  const startedAt = Date.now();
  const root = (await git(process.cwd(), ["rev-parse", "--show-toplevel"]));
  const gitDir = await git(root, ["rev-parse", "--absolute-git-dir"]);
  const file = typeof opts.plan === "string" ? path.resolve(opts.plan) : planPath(gitDir);

  let plan: ShipPlan;
  let write: boolean;
  if (opts.plan !== undefined) {
    if (!fs.existsSync(file)) throw new Error(`No plan at ${file}: run cast ship checkout --dry-run first`);
    plan = JSON.parse(fs.readFileSync(file, "utf-8"));
    write = steerPlan(plan, opts);
  } else {
    plan = await makePlan(root, { roster: (ids) => inboxRoster(ids), fetch: opts.fetch, log });
    steerPlan(plan, opts);
    write = true;
  }
  // The file says what ran, steering included, so a later --plan picks it up.
  if (write) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(plan, null, 2));
  }

  if (opts.dryRun) {
    // The plan file's own object, so what is read here is what is edited there; plan_file and ship ride beside it.
    console.log(opts.json ? JSON.stringify({ ...plan, plan_file: file, ship: shipSpec(root) }, null, 2) : formatPlan(plan, file));
    return;
  }

  const result = await runPlan(plan, { noCheck: opts.check === false, noPush: opts.push === false, noDeploy: opts.deploy === false, log });
  // Recorded whatever the outcome, so a stopped ship is as visible as a shipped one; a record that fails warns and never fails the ship.
  if (record && (result.commits.length || result.deploys.length || !result.ok)) {
    try {
      const { readLocalGitContext } = await import("../prCommand.js");
      const repository = readLocalGitContext(root).repository;
      const { deviceId } = await import("../remote/device.js");
      if (repository) {
        const recorded = await record(shipPassBody(plan, result, repository, startedAt, deviceId()));
        for (const d of recorded?.deploys ?? []) if (d.deploy) log(`recorded ${d.name} as ${d.deploy}`);
      }
    } catch (err) {
      log(`warning: the ship pass was not recorded in codecast: ${String((err as Error)?.message ?? err).slice(0, 300)}`);
    }
  }
  if (result.ok && result.pushed && file === planPath(gitDir)) fs.rmSync(file, { force: true });
  console.log(opts.json ? JSON.stringify(result, null, 2) : formatOutcome(result));
  if (!result.ok) process.exitCode = 1;
}
