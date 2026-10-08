/**
 * `cast ship checkout`: land everything uncommitted in a shared checkout in
 * one pass while the agents in it keep working (docs/architecture/ship-checkout.md).
 *
 *   plan   freeze the working tree, attribute each changed file to the
 *          session that wrote it, group by session, flag credentials. The
 *          plan pins the frozen tree, so what an agent judges is exactly what
 *          ships, however long the judging takes.
 *   run    commit each group from the frozen tree through a private index,
 *          replay the checkout's own commits and the new ones onto upstream
 *          in memory, level the checkout onto the result, check, deploy what
 *          must go before the push, push (replaying again if upstream moved),
 *          deploy the rest.
 *
 * Nothing here stashes, resets or rebases the shared tree: the only writes to
 * it are the level's (land/level.ts), which touch files nobody has changed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { execFileAsync } from "../proc.js";
import { SESSION_TRAILER_KEY, sessionTrailerValue } from "@codecast/shared/blame";
import { isCredentialFilePath, PRIVATE_KEY_RE, VENDOR_TOKEN_RE } from "../secretPatterns.js";
import { readSessionLinkCache } from "../localConversationMap.js";
import { git, gitTry } from "../wipSnapshot.js";
import { resolveManifest } from "../workspace/resolver.js";
import type { ShipDeployStep, ShipSpec } from "../workspace/types.js";
import { attributeEdits, isMidTurn, type SessionEdits } from "./attribute.js";
import { buildCommits, freezeWorktree, type Frozen } from "./commitGroups.js";
import { levelCheckout, type LevelResult } from "./level.js";
import { isAncestor, linearCommits, replayOnto } from "./replay.js";
import { readBlobs, type RosterRow } from "./scan.js";

export const PLAN_VERSION = 1;
/** Transcripts older than this are never read for attribution. */
const ATTRIBUTION_HORIZON_MS = 14 * 86_400_000;
const LAST_TEXT_CHARS = 600;

export const DEFAULT_SHIP: ShipSpec = { mode: "pr", check: "cast check", tests: true, level: false, deploy: [] };

export interface ShipSession {
  /** The 7-character codecast id, when the session syncs. */
  id: string | null;
  conversation_id: string | null;
  title: string | null;
  /** Server work state (working, idle, needs_input, done, ...), else the hook status on disk. */
  state: string | null;
  mid_turn: boolean;
  last_text: string | null;
  last_activity: string;
}

export interface ShipGroup {
  /** "s:<session id>", "unattributed", "credentials", or anything the editor names. */
  id: string;
  session: ShipSession | null;
  message: string;
  paths: string[];
  /** False holds the group's files back: they stay uncommitted for a later ship. */
  ship: boolean;
  /** Why the plan holds it, when it does. */
  note?: string;
  stat: { files: number; added: number; removed: number };
}

export interface ShipPlan {
  version: number;
  root: string;
  created_at: string;
  /** HEAD when the tree was frozen. */
  base: string;
  /** The frozen working tree. */
  tree: string;
  upstream: string;
  mode: "pr" | "direct";
  /** Commits on the checkout's branch that upstream lacks; they ship first. */
  local_commits: Array<{ sha: string; subject: string }>;
  behind: number;
  groups: ShipGroup[];
  attribution: { files: number; attributed: number; took_ms: number };
}


export type Log = (line: string) => void;

// ── plan ─────────────────────────────────────────────────────────────────────

export function planPath(gitDir: string): string {
  return path.join(gitDir, "codecast", "ship-plan.json");
}

/** `origin/main`, or whatever the remote's HEAD names. */
export async function upstreamRef(root: string): Promise<string> {
  const head = await gitTry(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head;
  for (const ref of ["origin/main", "origin/master"]) {
    if (await gitTry(root, ["rev-parse", "--verify", "--quiet", ref])) return ref;
  }
  throw new Error("No upstream: this checkout has no origin/main (or origin/HEAD)");
}

export function shipSpec(root: string): ShipSpec {
  try {
    return resolveManifest(root).ship ?? DEFAULT_SHIP;
  } catch {
    return DEFAULT_SHIP;
  }
}

function credentialReason(rel: string, text: string | null): string | null {
  if (isCredentialFilePath(rel)) return "named like a credential file";
  if (!text) return null;
  if (PRIVATE_KEY_RE.test(text)) return "holds a private key";
  if (VENDOR_TOKEN_RE.test(text)) return "holds an API token";
  return null;
}

/** A commit type and scope from a title and the paths it covers, for a default message a person would accept. */
export function defaultMessage(title: string | null, paths: string[]): string {
  const scopes = new Map<string, number>();
  for (const p of paths) {
    const parts = p.split("/");
    const scope = parts[0] === "packages" && parts[1] ? parts[1] : parts.length > 1 ? parts[0] : "repo";
    scopes.set(scope, (scopes.get(scope) ?? 0) + 1);
  }
  const scope = [...scopes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "repo";
  const allDocs = paths.every((p) => /\.(md|mdx|txt)$/i.test(p));
  const allTests = paths.every((p) => /\.(test|spec)\.[jt]sx?$/.test(p) || p.includes("__fixtures__") || p.includes("__golden__"));
  const subject = (title ?? "").trim().replace(/\s+/g, " ").replace(/[.!]+$/, "");
  const type = allDocs ? "docs" : allTests ? "test" : /\b(fix|bug|broken|crash|error|regress|leak)/i.test(subject) ? "fix" : "feat";
  const text = subject ? subject[0].toLowerCase() + subject.slice(1) : `changes in ${scope}`;
  return `${type}(${scope}): ${text.length > 72 ? `${text.slice(0, 69).trimEnd()}...` : text}`;
}

async function numstat(root: string, base: string, tree: string): Promise<Map<string, { added: number; removed: number }>> {
  const out = (await gitTry(root, ["diff-tree", "-r", "-z", "--numstat", "--no-renames", base, tree])) ?? "";
  const stats = new Map<string, { added: number; removed: number }>();
  for (const rec of out.split("\0")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(rec.trim());
    if (m) stats.set(m[3], { added: Number(m[1]) || 0, removed: Number(m[2]) || 0 });
  }
  return stats;
}

function oldestMtime(root: string, paths: string[]): number {
  let oldest = Date.now();
  for (const p of paths) {
    try { oldest = Math.min(oldest, fs.statSync(path.join(root, p)).mtimeMs); } catch {}
  }
  return oldest;
}

function shipSession(s: SessionEdits, roster: Map<string, RosterRow>): ShipSession {
  const id = s.conversationId ? s.conversationId.slice(0, 7) : null;
  const row = id ? roster.get(id) : undefined;
  const last = s.lastText ? (s.lastText.length > LAST_TEXT_CHARS ? `${s.lastText.slice(0, LAST_TEXT_CHARS)}...` : s.lastText) : null;
  const state = row?.work_state ?? s.status;
  return {
    id,
    conversation_id: s.conversationId,
    title: row?.title ?? null,
    state,
    mid_turn: isMidTurn(s) || row?.work_state === "working",
    last_text: last,
    last_activity: new Date(s.lastActivity).toISOString(),
  };
}

export async function makePlan(root: string, opts: { roster?: (ids: string[]) => Promise<RosterRow[] | null>; fetch?: boolean; log?: Log } = {}): Promise<ShipPlan> {
  const log = opts.log ?? (() => {});
  const spec = shipSpec(root);
  const upstream = await upstreamRef(root);
  if (opts.fetch !== false) {
    const [remote, branch] = [upstream.split("/")[0], upstream.split("/").slice(1).join("/")];
    await gitTry(root, ["fetch", "--quiet", remote, branch]);
  }

  const frozen = await freezeWorktree(root);
  const paths = frozen.changes.map((c) => c.path);
  log(`froze ${paths.length} changed file(s) at ${frozen.tree.slice(0, 9)}`);

  const since = Math.max(oldestMtime(root, paths) - 60_000, Date.now() - ATTRIBUTION_HORIZON_MS);
  const attribution = attributeEdits(root, paths, { since });
  log(`attributed ${attribution.owners.size}/${paths.length} to ${attribution.sessions.length} session(s) in ${attribution.tookMs}ms`);
  const owning = [...new Set([...attribution.owners.values()].map((s) => s.conversationId?.slice(0, 7)).filter((id): id is string => !!id))];
  const rows = opts.roster && owning.length ? await opts.roster(owning).catch(() => null) : null;
  const roster = new Map((rows ?? []).filter((r) => r.short_id).map((r) => [r.short_id!, r]));

  const stats = await numstat(root, frozen.base, frozen.tree);
  const byKey = new Map<string, ShipGroup>();
  const credentials: ShipGroup = { id: "credentials", session: null, message: "", paths: [], ship: false, note: "", stat: { files: 0, added: 0, removed: 0 } };
  const reasons: string[] = [];
  const texts = await readBlobs(root, frozen.changes.map((c) => c.blob ?? ""));
  for (const change of frozen.changes) {
    const reason = credentialReason(change.path, change.blob ? texts.get(change.blob) ?? null : null);
    if (reason) {
      credentials.paths.push(change.path);
      reasons.push(`${change.path}: ${reason}`);
      continue;
    }
    const owner = attribution.owners.get(change.path);
    const key = owner ? `s:${owner.conversationId?.slice(0, 7) ?? owner.sessionId.slice(0, 8)}` : "unattributed";
    let group = byKey.get(key);
    if (!group) {
      group = { id: key, session: owner ? shipSession(owner, roster) : null, message: "", paths: [], ship: true, stat: { files: 0, added: 0, removed: 0 } };
      byKey.set(key, group);
    }
    group.paths.push(change.path);
  }
  const groups = [...byKey.values()].sort((a, b) => (a.id === "unattributed" ? 1 : b.id === "unattributed" ? -1 : b.paths.length - a.paths.length));
  if (credentials.paths.length) {
    credentials.note = `Held: ${reasons.join("; ")}. Move a path to another group only if it holds no live secret.`;
    groups.push(credentials);
  }
  for (const g of groups) {
    g.paths.sort();
    g.stat = g.paths.reduce((acc, p) => ({ files: acc.files + 1, added: acc.added + (stats.get(p)?.added ?? 0), removed: acc.removed + (stats.get(p)?.removed ?? 0) }), { files: 0, added: 0, removed: 0 });
    if (!g.message) g.message = g.id === "credentials" ? "" : defaultMessage(g.session?.title ?? null, g.paths);
  }

  const head = frozen.base;
  const localCommits = (await isAncestor(root, head, upstream)) ? [] : await commitSubjects(root, upstream, head);
  const behind = Number((await gitTry(root, ["rev-list", "--count", `${head}..${upstream}`])) ?? 0);
  return {
    version: PLAN_VERSION,
    root,
    created_at: new Date().toISOString(),
    base: frozen.base,
    tree: frozen.tree,
    upstream,
    mode: spec.mode,
    local_commits: localCommits,
    behind,
    groups,
    attribution: { files: paths.length, attributed: attribution.owners.size, took_ms: attribution.tookMs },
  };
}

async function commitSubjects(root: string, from: string, to: string): Promise<Array<{ sha: string; subject: string }>> {
  const out = (await gitTry(root, ["log", "--reverse", "--format=%H%x09%s", `${from}..${to}`])) ?? "";
  return out.split("\n").filter(Boolean).map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) }));
}

/** Check an edited plan against the tree it pins. Returns the problems; empty means runnable. */
export async function validatePlan(root: string, plan: ShipPlan): Promise<string[]> {
  const problems: string[] = [];
  if (plan.version !== PLAN_VERSION) problems.push(`plan version ${plan.version}; this cast reads ${PLAN_VERSION}`);
  if ((await gitTry(root, ["cat-file", "-e", `${plan.tree}^{tree}`])) === null) problems.push(`frozen tree ${plan.tree.slice(0, 9)} is gone; plan again`);
  if ((await gitTry(root, ["cat-file", "-e", `${plan.base}^{commit}`])) === null) problems.push(`base ${plan.base.slice(0, 9)} is gone; plan again`);
  if (problems.length) return problems;
  const changed = new Set((await freezeChanges(root, plan)).map((c) => c.path));
  const seen = new Map<string, string>();
  for (const g of plan.groups) {
    if (g.ship && !g.message.trim()) problems.push(`group ${g.id} ships without a message`);
    for (const p of g.paths) {
      if (!changed.has(p)) problems.push(`${p} (group ${g.id}) is not a change in the frozen tree`);
      const prior = seen.get(p);
      if (prior) problems.push(`${p} is in both ${prior} and ${g.id}`);
      seen.set(p, g.id);
    }
  }
  return problems;
}

async function freezeChanges(root: string, plan: Pick<ShipPlan, "base" | "tree">): Promise<Frozen["changes"]> {
  const { treeDiff } = await import("./level.js");
  return (await treeDiff(root, plan.base, plan.tree)).map((e) => ({ path: e.path, blob: e.dst, mode: e.dst ? e.dstMode : e.srcMode, added: !e.src }));
}

// ── run ──────────────────────────────────────────────────────────────────────

export interface RunOptions {
  /** Skip the check and tests (CI still runs). */
  noCheck?: boolean;
  /** Build, replay and level, but push and deploy nothing. */
  noPush?: boolean;
  noDeploy?: boolean;
  log?: Log;
  /** Overridable for tests. */
  exec?: (command: string, cwd: string, log: Log) => Promise<{ code: number; output: string }>;
}

export interface ShipOutcome {
  ok: boolean;
  stage: "plan" | "commit" | "replay" | "level" | "check" | "deploy" | "push" | "done";
  reason?: string;
  commits: Array<{ sha: string; message: string; group: string; files: number }>;
  tip?: string;
  pushed?: string;
  held: Array<{ group: string; paths: string[]; note?: string }>;
  level?: LevelResult;
  check?: { command: string; ok: boolean; ignored?: string[]; output?: string };
  deploys: Array<{ name: string; stage: string; ok: boolean; output?: string }>;
  import_gaps?: string[];
  pr?: string;
}

/** Run a shell command, streaming nothing, capturing the tail of its output. */
export function runShell(command: string, cwd: string, log: Log): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-c", command], { cwd, env: { ...process.env, CAST_SHIP: "1" } });
    let output = "";
    const take = (b: Buffer) => { output = (output + b.toString()).slice(-200_000); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const started = Date.now();
    const tick = setInterval(() => log(`  ... ${command.split(" ")[0]} still running (${Math.round((Date.now() - started) / 1000)}s)`), 60_000);
    child.on("close", (code) => { clearInterval(tick); resolve({ code: code ?? 1, output }); });
    child.on("error", (err) => { clearInterval(tick); resolve({ code: 127, output: String(err) }); });
  });
}

function trailerFor(group: ShipGroup): string {
  const conversationId = group.session?.conversation_id;
  if (!conversationId) return "";
  const links = readSessionLinkCache();
  const visible = Object.values(links).some((l) => l?.conversation_id === conversationId && l.team_visible);
  return visible ? `\n\n${SESSION_TRAILER_KEY}: ${sessionTrailerValue(conversationId)}` : "";
}

/** Relative imports in a shipped file that resolve only to a file the commit lacks. */
export function importGaps(source: string, file: string, inTree: (p: string) => boolean, onDisk: (p: string) => boolean): string[] {
  if (!/\.(m|c)?[jt]sx?$/.test(file)) return [];
  const gaps: string[] = [];
  const dir = path.posix.dirname(file);
  const specs = [...source.matchAll(/(?:from\s+|import\s*\(\s*|require\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g)].map((m) => m[1]);
  for (const spec of new Set(specs)) {
    const target = path.posix.normalize(path.posix.join(dir, spec));
    const stem = target.replace(/\.(m|c)?js$/, "");
    const candidates = [target, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.jsx`, `${stem}.mjs`, `${stem}.cjs`, `${target}/index.ts`, `${target}/index.tsx`, `${target}/index.js`];
    if (candidates.some(inTree)) continue;
    if (candidates.some(onDisk)) gaps.push(`${file} imports ${spec}, which is held back or not committed`);
  }
  return gaps;
}

/** Errors in a check's output that name only files left out of this ship. */
export function errorsOutsideShip(output: string, unshipped: Set<string>): { ours: string[]; theirs: string[] } {
  const ours: string[] = [];
  const theirs: string[] = [];
  for (const line of output.split("\n")) {
    const m = /([\w@./()[\]-]+\.(?:m|c)?[jt]sx?)[(:]\d+/.exec(line);
    if (!m || !/error/i.test(line)) continue;
    const file = m[1].replace(/^\.\//, "");
    const hit = [...unshipped].some((u) => u === file || u.endsWith(`/${file}`) || file.endsWith(`/${u}`));
    (hit ? theirs : ours).push(line.trim());
  }
  return { ours, theirs };
}

function globMatch(pattern: string, file: string): boolean {
  const BunGlob = (globalThis as any).Bun?.Glob;
  if (BunGlob) return new BunGlob(pattern).match(file);
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, "[^/]")}$`);
  return re.test(file);
}

export function deploysFor(steps: ShipDeployStep[], shipped: string[]): ShipDeployStep[] {
  return steps.filter((s) => !s.when.length || shipped.some((p) => s.when.some((g) => globMatch(g, p))));
}

/** Hold an exclusive lock on shipping this checkout; returns the release. */
function lock(gitDir: string): () => void {
  const dir = path.join(gitDir, "codecast");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "ship.lock");
  try {
    fs.writeFileSync(file, String(process.pid), { flag: "wx" });
  } catch {
    const holder = Number(fs.readFileSync(file, "utf-8").trim());
    let alive = false;
    try { process.kill(holder, 0); alive = true; } catch {}
    if (alive && holder !== process.pid) throw new Error(`another cast ship (pid ${holder}) is shipping this checkout; wait for it`);
    fs.writeFileSync(file, String(process.pid));
  }
  return () => { try { fs.rmSync(file); } catch {} };
}

export async function runPlan(plan: ShipPlan, opts: RunOptions = {}): Promise<ShipOutcome> {
  const log = opts.log ?? (() => {});
  const exec = opts.exec ?? runShell;
  const root = plan.root;
  const spec = shipSpec(root);
  const gitDir = await git(root, ["rev-parse", "--absolute-git-dir"]);
  const out: ShipOutcome = { ok: false, stage: "plan", commits: [], held: [], deploys: [] };
  const fail = (stage: ShipOutcome["stage"], reason: string): ShipOutcome => ({ ...out, ok: false, stage, reason });

  const problems = await validatePlan(root, plan);
  if (problems.length) return fail("plan", problems.join("\n"));
  const release = lock(gitDir);
  try {
    const shipping = plan.groups.filter((g) => g.ship && g.paths.length);
    out.held = plan.groups.filter((g) => !g.ship && g.paths.length).map((g) => ({ group: g.id, paths: g.paths, ...(g.note ? { note: g.note } : {}) }));

    // 1. Commits from the frozen tree, on the frozen base.
    out.stage = "commit";
    const changes = await freezeChanges(root, plan);
    const built = await buildCommits(root, { base: plan.base, tree: plan.tree, changes }, shipping.map((g) => ({ message: g.message.trim() + trailerFor(g), paths: g.paths })));
    built.commits.forEach((sha, i) => { if (sha) out.commits.push({ sha, message: shipping[i].message.split("\n")[0], group: shipping[i].id, files: shipping[i].paths.length }); });
    log(`committed ${out.commits.length} group(s) on ${plan.base.slice(0, 9)}`);

    // 2. Replay: the branch's own commits since upstream, then ours, onto upstream.
    out.stage = "replay";
    const head = await git(root, ["rev-parse", "HEAD"]);
    if (!(await isAncestor(root, plan.base, head))) return fail("replay", `HEAD moved off the frozen base ${plan.base.slice(0, 9)} (history rewritten?); plan again`);
    const upstream = plan.upstream;
    const local = await replayOnto(root, upstream, head, upstream);
    if (!local.ok) return fail("replay", `this checkout's own commit ${local.reason}`);
    const ours = await replayOnto(root, plan.base, built.tip, local.tip);
    if (!ours.ok) return fail("replay", ours.reason);
    let tip = ours.tip;
    out.tip = tip;
    const upstreamSha = await git(root, ["rev-parse", upstream]);
    if (tip === upstreamSha) {
      log("nothing to ship: upstream already holds everything");
      if (spec.mode === "direct") out.level = await levelCheckout(root, tip, { rewritten: true });
      return { ...out, ok: true, stage: "done" };
    }
    log(`replayed ${(await linearCommits(root, upstreamSha, tip)).length} commit(s) onto ${upstream} (${upstreamSha.slice(0, 9)})`);

    const shippedPaths = [...new Set(((await gitTry(root, ["diff-tree", "-r", "--name-only", "--no-commit-id", upstreamSha, tip])) ?? "").split("\n").filter(Boolean))];

    // 3. Held files a shipped file imports would break the commit even though the tree typechecks.
    if (out.held.length) {
      const inTip = new Set(((await git(root, ["ls-tree", "-r", "--name-only", tip])) || "").split("\n"));
      const gaps: string[] = [];
      for (const p of shippedPaths) {
        if (!inTip.has(p)) continue;
        const source = await gitTry(root, ["cat-file", "blob", `${tip}:${p}`]);
        if (source) gaps.push(...importGaps(source, p, (x) => inTip.has(x), (x) => fs.existsSync(path.join(root, x))));
      }
      if (gaps.length) { out.import_gaps = gaps; return fail("check", `the shipped commits import files held back:\n${gaps.join("\n")}`); }
    }

    if (spec.mode === "pr") return await shipAsPullRequest(root, plan, tip, upstream, out, log);

    // 4. Level the checkout onto the tip: the check below reads these files.
    out.stage = "level";
    const worktreeBase = new Map(changes.map((c) => [c.path, c.blob] as const));
    const lv = await levelCheckout(root, tip, { rewritten: true, worktreeBase });
    out.level = lv;
    if (!lv.ok) return fail("level", `${lv.reason}${lv.conflicts.length ? `: ${lv.conflicts.join(", ")}` : ""}`);
    log(`levelled the checkout to ${tip.slice(0, 9)} (${lv.written.length} written, ${lv.merged.length} merged, ${lv.absorbed.length} absorbed)`);

    // 5. Check, ignoring errors that live only in files this ship left out.
    if (!opts.noCheck && spec.check.trim()) {
      out.stage = "check";
      const unshipped = new Set(((await gitTry(root, ["diff", "--name-only", "HEAD"])) ?? "").split("\n").filter(Boolean));
      for (const u of ((await gitTry(root, ["ls-files", "--others", "--exclude-standard"])) ?? "").split("\n")) if (u) unshipped.add(u);
      log(`checking: ${spec.check}`);
      const r = await exec(spec.check, root, log);
      if (r.code !== 0) {
        const { ours: mine, theirs } = errorsOutsideShip(r.output, unshipped);
        if (mine.length || !theirs.length) {
          out.check = { command: spec.check, ok: false, output: r.output.slice(-6000) };
          return fail("check", `${spec.check} failed${mine.length ? ` in shipped files:\n${mine.slice(0, 20).join("\n")}` : ""}`);
        }
        out.check = { command: spec.check, ok: true, ignored: theirs.slice(0, 50) };
        log(`check passed for the shipped files (${theirs.length} error(s) in files left out)`);
      } else {
        out.check = { command: spec.check, ok: true };
      }
      if (spec.tests) {
        const tests = shippedPaths.filter((p) => /\.test\.[jt]sx?$/.test(p) && fs.existsSync(path.join(root, p)));
        const r2 = await runTests(root, tests, exec, log);
        if (r2) { out.check = { command: r2.command, ok: false, output: r2.output.slice(-6000) }; return fail("check", `${r2.command} failed`); }
      }
    }

    if (opts.noPush) return { ...out, ok: true, stage: "done", reason: "built and levelled; nothing pushed (--no-push)" };

    // 6. Deploys that must precede the push (a backend the pushed client calls).
    const steps = opts.noDeploy ? [] : deploysFor(spec.deploy, shippedPaths);
    for (const step of steps.filter((s) => s.stage === "before_push")) {
      out.stage = "deploy";
      log(`deploying ${step.name}: ${step.run}`);
      const r = await exec(step.run, root, log);
      out.deploys.push({ name: step.name, stage: step.stage, ok: r.code === 0, ...(r.code ? { output: r.output.slice(-6000) } : {}) });
      if (r.code !== 0) return fail("deploy", `${step.name} failed before the push; nothing was pushed`);
    }

    // 7. Push; when upstream moved, replay onto it and level again.
    out.stage = "push";
    const [remote, branch] = [upstream.split("/")[0], upstream.split("/").slice(1).join("/")];
    for (let attempt = 0; ; attempt++) {
      const pushed = await gitTry(root, ["push", "--quiet", remote, `${tip}:refs/heads/${branch}`]);
      if (pushed !== null) break;
      if (attempt >= 4) return fail("push", `push to ${upstream} kept failing; the commits are on the local branch and ship next time`);
      const before = await git(root, ["rev-parse", upstream]);
      await gitTry(root, ["fetch", "--quiet", remote, branch]);
      const now = await git(root, ["rev-parse", upstream]);
      if (now === before) return fail("push", `push to ${upstream} was refused and upstream did not move (permissions? branch protection? try mode = "pr")`);
      const again = await replayOnto(root, before, tip, upstream);
      if (!again.ok) return fail("push", `upstream moved and conflicts: ${again.reason}`);
      tip = again.tip;
      const lv2 = await levelCheckout(root, tip, { rewritten: true });  // the checkout already sits on the shipped content
      if (!lv2.ok) return fail("level", `upstream moved; ${lv2.reason}`);
      log(`upstream moved; replayed onto ${now.slice(0, 9)}`);
    }
    out.tip = tip;
    out.pushed = tip;
    await gitTry(root, ["update-ref", `refs/remotes/${upstream}`, tip]);
    log(`pushed ${tip.slice(0, 9)} to ${upstream}`);

    // 8. The rest of the deploys.
    for (const step of steps.filter((s) => s.stage === "after_push")) {
      out.stage = "deploy";
      log(`deploying ${step.name}: ${step.run}`);
      const r = await exec(step.run, root, log);
      out.deploys.push({ name: step.name, stage: step.stage, ok: r.code === 0, ...(r.code ? { output: r.output.slice(-6000) } : {}) });
      if (r.code !== 0) return { ...out, ok: false, stage: "deploy", reason: `pushed, but ${step.name} failed` };
    }
    return { ...out, ok: true, stage: "done" };
  } finally {
    release();
  }
}

/** Run the changed test files with bun, per package, from inside each package (bun misreads spawns from the repo root). */
async function runTests(root: string, tests: string[], exec: NonNullable<RunOptions["exec"]>, log: Log): Promise<{ command: string; output: string } | null> {
  if (!tests.length || !fs.existsSync(path.join(root, "bun.lock"))) return null;
  const byPkg = new Map<string, string[]>();
  for (const t of tests) {
    let dir = path.posix.dirname(t);
    while (dir !== "." && !fs.existsSync(path.join(root, dir, "package.json"))) dir = path.posix.dirname(dir);
    const list = byPkg.get(dir) ?? [];
    list.push(path.posix.relative(dir === "." ? "" : dir, t));
    byPkg.set(dir, list);
  }
  for (const [dir, files] of byPkg) {
    const command = `bun test ${files.map((f) => `./${f}`).join(" ")}`;
    log(`testing ${files.length} changed test file(s) in ${dir}`);
    const r = await exec(command, path.join(root, dir), log);
    if (r.code !== 0) return { command: `(cd ${dir} && ${command})`, output: r.output };
  }
  return null;
}

async function shipAsPullRequest(root: string, plan: ShipPlan, tip: string, upstream: string, out: ShipOutcome, log: Log): Promise<ShipOutcome> {
  out.stage = "push";
  const [remote, base] = [upstream.split("/")[0], upstream.split("/").slice(1).join("/")];
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const branch = `cast-ship/${stamp}`;
  if ((await gitTry(root, ["push", "--quiet", remote, `${tip}:refs/heads/${branch}`])) === null) {
    return { ...out, ok: false, stage: "push", reason: `could not push ${branch}` };
  }
  log(`pushed ${branch}`);
  const title = out.commits.length === 1 ? out.commits[0].message : `Ship ${out.commits.length} changes from the shared checkout`;
  const body = [
    "Shipped by `cast ship checkout` from the shared checkout.",
    "",
    ...out.commits.map((c) => `- ${c.message} (${c.files} file${c.files === 1 ? "" : "s"})`),
    ...(out.held.length ? ["", `Held back: ${out.held.map((h) => `${h.group} (${h.paths.length})`).join(", ")}`] : []),
  ].join("\n");
  let url: string | undefined;
  let error = "";
  try {
    const { stdout } = await execFileAsync("gh", ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body", body], { cwd: root, encoding: "utf-8" });
    url = /https:\/\/\S+\/pull\/\d+/.exec(String(stdout))?.[0];
  } catch (err) {
    error = String((err as { stderr?: string })?.stderr || (err as Error)?.message || err).trim();
  }
  if (!url) return { ...out, ok: false, stage: "push", reason: `pushed ${branch}, but gh pr create failed: ${error.slice(-500)}` };
  log(`opened ${url}`);
  return { ...out, ok: true, stage: "done", pushed: tip, pr: url };
}
