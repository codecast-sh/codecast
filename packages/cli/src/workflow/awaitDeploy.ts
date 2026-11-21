// The Deploy stage of a change flow (docs/architecture/flows.md FL4): it starts
// from the commit Merge put on the default branch, sends the release targets
// the change touches, waits on the ones that deploy themselves (push, auto),
// and says when the commit is live on each (dp-N), that a deploy failed, or that
// a target missed its deadline. It reads the targets from the checkout's files
// (deploys.md DP10) and what runs on each as `cast line deploy targets --json`
// prints it, and decides which deploy carries the commit with git ancestry, so
// it needs nothing from the server beyond what every target already records.
// The station that runs it parks: while it waits the run holds no slot and no
// session.
import { spawn } from "../proc.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEPLOY_WAIT_CAP_MS, deployDeadlineMs, releaseOrder, type DeployTarget } from "@codecast/shared/contracts/deployTargets";
import { git, gitTry } from "../wipSnapshot.js";

/** One deploy of a target, as the targets read lists its history. */
export type TargetDeploy = { short_id: string; status: string; sha?: string | null; created_at?: number; live_at?: number | null; finished_at?: number | null; note?: string | null };
export type DeployTargetRow = { name: string; paths?: string[]; runs?: string; live?: TargetDeploy | null; open?: TargetDeploy | null; history?: TargetDeploy[] };

export type TargetState =
  | { target: string; state: "live"; deploy: TargetDeploy }
  | { target: string; state: "failed"; deploy: TargetDeploy }
  | { target: string; state: "deploying"; deploy: TargetDeploy }
  | { target: string; state: "waiting" };

/** How often a Deploy station asks origin again when a fetch fails, and how long it waits between. */
const FETCH_RETRY = { tries: 3, delayMs: 5000 };

/**
 * The commit Merge put on `base` (its merge.json sha) and the change's files. A run with no merged sha, or one whose
 * sha is not on origin's `base`, merged nothing, and the stage says so at once rather than wait for a landing.
 * `known` is the change's files when the run knows them (`$change_files`, or the files merge.json names), else the
 * merged commit's own.
 */
export async function mergedCommit(cwd: string, sha: string | undefined, base: string, known?: ReadonlyArray<string>, fetch: { tries: number; delayMs: number } = FETCH_RETRY): Promise<{ sha: string; files: string[] } | { error: string; unread?: true }> {
  if (!sha?.trim()) return { error: `Nothing was merged: the run has no merged commit, so nothing goes out.` };
  // A fetch that fails says nothing about the merge: it is asked again, and then the station says it could not read
  // origin, never that nothing was merged.
  let failed: string | null = null;
  for (let i = 0; i < fetch.tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, fetch.delayMs));
    failed = await git(cwd, ["fetch", "-q", "origin", base]).then(() => null, (err) => (err instanceof Error ? err.message : String(err)).trim().split("\n").pop() || "git fetch failed");
    if (!failed) break;
  }
  if (failed) return { error: `Cannot read origin/${base} to find ${sha.trim().slice(0, 10)}: git fetch failed ${fetch.tries} times (${failed.slice(0, 200)}).`, unread: true };
  const full = (await gitTry(cwd, ["rev-parse", "-q", "--verify", `${sha.trim()}^{commit}`]))?.trim();
  if (!full || (await gitTry(cwd, ["merge-base", "--is-ancestor", full, `origin/${base}`])) === null) {
    return { error: `Nothing was merged: ${sha.trim().slice(0, 10)} is not on origin/${base}, so nothing goes out.` };
  }
  const files = known?.length ? [...known] : (await git(cwd, ["diff", "--name-only", "--no-renames", `${full}^`, full]).catch(() => "")).split("\n").filter(Boolean);
  return { sha: full, files };
}

/**
 * Whether the change on `branch` is on `base` yet, for a run's end retiring its subject (runner.ts retireSubject), which
 * may come from a flow with no Merge station. Deploy never reads it: it starts only from the merged sha (mergedCommit).
 * The commit on `base` that carries the change on `branch`: the branch itself
 * once main holds it, else the commit whose every file reads as the branch left
 * it (a squash). Null until it lands. `known` is the change's files when the run
 * knows them (`$change_files`); once main holds the branch nothing is left to
 * diff it against, so without them the tip commit's own files stand for it.
 */
export async function landedCommit(cwd: string, branch: string, base: string, known?: ReadonlyArray<string>): Promise<{ sha: string; files: string[] } | null> {
  await gitTry(cwd, ["fetch", "-q", "origin", base]);
  const upstream = `origin/${base}`;
  const tip = (await git(cwd, ["rev-parse", branch])).trim();
  const fork = (await git(cwd, ["merge-base", tip, upstream])).trim();
  const names = (from: string) => git(cwd, ["diff", "--name-only", "--no-renames", from, tip]).then((s) => s.split("\n").filter(Boolean));
  if (fork === tip) return { sha: tip, files: known?.length ? [...known] : await names(`${tip}~1`).catch(() => []) };
  const files = known?.length ? [...known] : await names(fork);
  if (!files.length) return null;
  const blob = (rev: string, f: string) => gitTry(cwd, ["rev-parse", "-q", "--verify", `${rev}:${f}`]).then((s) => s?.trim() ?? "");
  const want = await Promise.all(files.map((f) => blob(tip, f)));
  const candidates = (await git(cwd, ["log", "--reverse", "--format=%H", `${fork}..${upstream}`, "--", ...files])).split("\n").filter(Boolean);
  for (const c of candidates) {
    const got = await Promise.all(files.map((f) => blob(c, f)));
    if (got.every((g, i) => g === want[i])) return { sha: c, files };
  }
  // A change replayed onto a main that moved in the same files (the merge step replays a branch onto main) has no
  // commit reading as the branch left it. It landed at the first commit that already holds all of it: merging the
  // branch into that commit changes nothing.
  for (const c of candidates) {
    const merged = await gitTry(cwd, ["merge-tree", "--write-tree", c, tip]);
    if (merged && merged.split("\n")[0].trim() === (await git(cwd, ["rev-parse", `${c}^{tree}`])).trim()) return { sha: c, files };
  }
  return null;
}

/** Whether a target ships any of these files: its path globs, or every path when it names none. */
export function targetTouches(paths: ReadonlyArray<string> | undefined, files: ReadonlyArray<string>): boolean {
  if (!paths?.length) return true;
  const globs = paths.map((p) => new Bun.Glob(p));
  return files.some((f) => globs.some((g) => g.match(f)));
}

/**
 * Where the commit stands on one target: live once a live deploy's sha holds it, failed when the newest deploy that
 * would have carried it failed and none since carries it, going out while an open deploy holds it, else waiting for a
 * deploy. `carries(sha)` says whether a deployed sha holds the commit (git ancestry).
 */
export async function targetState(t: DeployTargetRow, carries: (sha: string) => Promise<boolean>): Promise<TargetState> {
  const rows = [...(t.history ?? []), ...(t.live ? [t.live] : []), ...(t.open ? [t.open] : [])]
    .filter((d, i, all) => d.sha && all.findIndex((x) => x.short_id === d.short_id) === i)
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  const holding: TargetDeploy[] = [];
  for (const d of rows) if (await carries(d.sha!)) holding.push(d);
  // The first live deploy that carried it is the one that took it live.
  const live = holding.filter((d) => d.status === "live").sort((a, b) => (a.live_at ?? a.created_at ?? 0) - (b.live_at ?? b.created_at ?? 0))[0];
  if (live) return { target: t.name, state: "live", deploy: live };
  const newest = holding[0];
  if (newest?.status === "failed") return { target: t.name, state: "failed", deploy: newest };
  if (newest && (newest.status === "requested" || newest.status === "running")) return { target: t.name, state: "deploying", deploy: newest };
  return { target: t.name, state: "waiting" };
}

/** Whether `ancestor` is in the history of `sha`, read in `cwd` (a sha this checkout lacks holds nothing). */
export async function holds(cwd: string, ancestor: string, sha: string): Promise<boolean> {
  if (ancestor === sha) return true;
  if ((await gitTry(cwd, ["cat-file", "-e", `${sha}^{commit}`])) === null) return false;
  return (await gitTry(cwd, ["merge-base", "--is-ancestor", ancestor, sha])) !== null;
}

/**
 * The CI verdict a target's send waits on: the workflow its `ci` step names, or every CI workflow on the commit, never
 * the deploy workflows targets name (`exclude`, deploy.toml `workflow`): a deploy's own run is no verdict on the code.
 */
export type CiGate = { workflow?: string; exclude?: string[] };

/**
 * A target the run owns: Live means every touched target carries the change. `send`: a release target that runs here,
 * which the stage sends and then waits on. `wait`: a push target (it deploys itself when main moves), an auto one (the
 * server sends it once CI on main is green), a release target in a flow that sends nothing (`send=""`), or one a person
 * or a role sends (`others`: a press target, the line profile's own), which the run only ever waits on.
 */
export type Duty = {
  target: string;
  action: "send" | "wait";
  how: "release" | "push" | "auto" | "others";
  /** Who sends an `others` target: "a person", or the line's role ("@release"). */
  by?: string;
  deadlineMs: number;
  /** Its send waits for main CI's verdict: its `ci` step's workflow, or for an auto target the server's green-CI rule. */
  ci: CiGate | null;
  /** Touched targets that must be live with the commit before the run sends it. */
  after: string[];
};

export type DeployDuties = { duties: Duty[]; /** Touched targets held back on purpose (`except`), which the run does not wait on. */ left: string[] };

/** The workflow a `ci` step's verdict comes from (`cast line deploy ci --workflow ci.yml`); none means every check. */
export function ciGateOf(ci: string): CiGate {
  const workflow = ci.match(/--workflow[ =](\S+)/)?.[1];
  return workflow ? { workflow } : {};
}

/**
 * The target a line profile's `[line.deploy]` sends, with who sends it: a person pressing Deploy, or the line's role.
 * The run never sends it, whatever its policy says; it waits for it.
 */
export function lineHeld(deploy: { command?: string | null; target?: string | null; trigger?: string | null; role?: string | null } | null | undefined): Record<string, string> {
  if (!deploy?.command && !deploy?.target) return {};
  const name = (deploy.target ?? "deploy").toLowerCase();
  return { [name]: deploy.trigger === "role" && deploy.role ? `@${deploy.role}` : "a person" };
}

/**
 * What the stage does with each target the change's files touch: sends `release` targets that run here (only waits on
 * them with `send: false`), waits on `push` and `auto` ones, and waits on, never sends, `press` targets and the line
 * profile's own target (`held`: target to who sends it). A target held back on purpose (`except`) is not waited on,
 * but still holds the targets that go after it.
 */
export function deployDuties(declared: DeployTarget[], files: ReadonlyArray<string>, opts: { except?: ReadonlyArray<string>; held?: Readonly<Record<string, string>>; send?: boolean } = {}): DeployDuties {
  const duties: Duty[] = [];
  const left: string[] = [];
  const send = opts.send ?? true;
  // A deploy workflow's own run says nothing about the code, so no gate that reads every workflow waits on one.
  const exclude = declared.flatMap((t) => (t.workflow ? [t.workflow] : []));
  const gate = (g: CiGate): CiGate => (g.workflow || !exclude.length ? g : { ...g, exclude });
  const touched = new Set<string>();
  for (const t of releaseOrder(declared)) {
    if (!targetTouches(t.paths, files)) continue;
    touched.add(t.name);
    const held = opts.held?.[t.name];
    if (opts.except?.includes(t.name)) left.push(`${t.name} is held back`);
    else if (held || (t.runs === "here" && t.policy === "press")) duties.push({ target: t.name, action: "wait", how: "others", by: held ?? "a person", deadlineMs: deployDeadlineMs(t, true), ci: null, after: [] });
    else if (t.runs === "push") duties.push({ target: t.name, action: "wait", how: "push", deadlineMs: deployDeadlineMs(t), ci: null, after: [] });
    else if (t.policy === "auto") duties.push({ target: t.name, action: "wait", how: "auto", deadlineMs: deployDeadlineMs(t), ci: gate({}), after: [] });
    else duties.push({ target: t.name, action: send ? "send" : "wait", how: "release", deadlineMs: deployDeadlineMs(t), ci: t.ci ? gate(ciGateOf(t.ci)) : null, after: t.after ?? [] });
  }
  // An `after` the change does not touch is not waited on, as a release has it.
  return { duties: duties.map((d) => ({ ...d, after: d.after.filter((a) => touched.has(a)) })), left };
}

/** Main CI on one commit: its state and the jobs that failed. */
export type MainCi = { state: "passed" | "failed" | "running" | "none"; red: string[] };

/**
 * When the wait for one merged commit began and when each target's own deadline started, kept beside the run's files
 * so a station re-run mid-wait keeps them. `stuck` marks a wait that ended at Deploy stuck: a resume of that run is a
 * person asking for another try, which starts a fresh clock.
 */
export type DeployClock = { sha: string; start: number; since: Record<string, number>; stuck?: boolean };

export type DeployWaitIO = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Main's head on origin, fetched fresh, so a deploy of a newer head is in this checkout's history. */
  mainHead: () => Promise<string | null>;
  /** The targets as the server records them (what is live and going out on each); null when the read failed. */
  targets: () => Promise<DeployTargetRow[] | null>;
  /** Whether a deployed sha holds the merged commit. */
  carries: (deployed: string) => Promise<boolean>;
  /** CI on a commit of main, as one target's gate reads it. */
  mainCi: (sha: string, gate: CiGate) => Promise<MainCi>;
  /** Where main went red at or before this commit, in words ("5e4d3c2", or the culprit and its subject), when known. */
  redSince: (sha: string, gate: CiGate) => Promise<string | null>;
  /** Send these targets (`cast deploy`); resolves when that release ends, with its exit code and last lines. */
  send: (targets: string[]) => Promise<{ code: number; last: string }>;
  /** Where the change stands, each time that changes. */
  progress: (line: string) => void;
  /** One blocker on the run's task. */
  block: (text: string) => Promise<void>;
  clock: { load: () => DeployClock | null; save: (c: DeployClock) => void };
};

export type DeployWaitResult = { code: 0 | 1 | 3 | 5; line: string };

const minutes = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m >= 120 ? `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}` : `${m}m`;
};

/**
 * Send the run's release targets, each once main CI and its `after` targets allow it, and wait until the merged
 * commit is live on every target it owns. A target's deadline runs from when it could first go out; the whole wait is
 * capped at DEPLOY_WAIT_CAP_MS. Ends 0 live, 1 when a deploy that would carry it failed, 5 when a target missed its
 * deadline or the cap (after one blocker on the task), and with `once` (which sends nothing) 3 while it still waits.
 */
export async function awaitDeploy(input: { sha: string; base: string; plan: DeployDuties; intervalMs: number; once?: boolean }, io: DeployWaitIO): Promise<DeployWaitResult> {
  const { sha, plan } = input;
  const short = sha.slice(0, 7);
  const tail = plan.left.length ? ` ${plan.left.join("; ")}.` : "";
  if (!plan.duties.length) return { code: 0, line: `${short} is on main; nothing this run deploys ships its files.${tail}` };
  const kept = io.clock.load();
  const clock: DeployClock = kept && kept.sha === sha && !kept.stuck ? kept : { sha, start: io.now(), since: {} };
  io.clock.save(clock);
  // Each release target asked for: null while its `cast deploy` runs, then how that ended.
  const sent = new Map<string, { code: number; last: string } | null>();
  // Deploys that failed at a head main had not yet passed: a hold, not a failure, for as long as the wait runs.
  const heldDeploys = new Set<string>();
  // Where each target last stood, so a deadline missed while the server cannot be read still names a state.
  const live = new Map<string, string>();
  const said = new Map<string, { words: string; detail?: string }>(plan.duties.map((d) => [d.target, { words: "nothing recorded yet" }]));
  const words = (t: string, clockText?: string) => {
    const s = said.get(t)!;
    const paren = [s.detail, clockText].filter(Boolean).join("; ");
    return `${s.words}${paren ? ` (${paren})` : ""}`;
  };
  let line = "";
  for (;;) {
    // Taken before the targets are read: a release that had ended by now has its deploys in that read.
    const ended = new Map(sent);
    const head = await io.mainHead();
    const rows = await io.targets();
    const now = io.now();
    if (rows) {
      const ci = new Map<string, MainCi>();
      const ciAt = async (at: string, gate: CiGate) => {
        const key = `${at} ${gate.workflow ?? `* -${(gate.exclude ?? []).join(",")}`}`;
        return ci.get(key) ?? ci.set(key, await io.mainCi(at, gate)).get(key)!;
      };
      // An `after` target the run does not send (a person, a role, a push or the server sends it, or it is held back)
      // holds its dependents until a deploy carrying the commit is live on it, as the target's own record says (a ship
      // pass that sent it before the merge counts). One the run sends goes in the same `cast deploy`, which orders them.
      const owned = new Set(plan.duties.map((d) => d.target));
      const sends = new Set(plan.duties.filter((d) => d.action === "send").map((d) => d.target));
      const outsideLive = new Map<string, boolean>();
      for (const a of new Set(plan.duties.flatMap((d) => d.after).filter((a) => !owned.has(a)))) {
        const row = rows.find((r) => r.name === a);
        outsideLive.set(a, row ? (await targetState(row, io.carries)).state === "live" : false);
      }
      const states = new Map<string, TargetState>();
      for (const d of plan.duties) {
        const row = rows.find((r) => r.name === d.target);
        let s: TargetState = row ? await targetState(row, io.carries) : { target: d.target, state: "waiting" };
        // A gated send that went out at a head that turned out red or still running failed at its own CI step: main
        // moved between the gate and the send (a deploy sends main's head, DP13). Red main holds a release, it does
        // not fail it, so the target goes back to waiting for green and is sent again.
        if (s.state === "failed" && d.action === "send" && d.ci && s.deploy.sha && (heldDeploys.has(s.deploy.short_id) || (await ciAt(s.deploy.sha, d.ci)).state !== "passed")) {
          heldDeploys.add(s.deploy.short_id);
          s = { target: d.target, state: "waiting" };
          if (ended.get(d.target)) { sent.delete(d.target); ended.delete(d.target); }
        }
        states.set(d.target, s);
      }
      const failed = [...states.values()].filter((s): s is Extract<TargetState, { state: "failed" }> => s.state === "failed");
      if (failed.length) return { code: 1, line: `The deploy that carried ${short} failed: ${failed.map((s) => `${s.target} ${s.deploy.short_id}${s.deploy.note ? ` (${s.deploy.note.split("\n")[0]})` : ""}`).join(", ")}.` };
      // Once a target's release has ended with no deploy carrying the commit, it will get none.
      const unsent = plan.duties.filter((d) => ended.get(d.target) && states.get(d.target)!.state === "waiting");
      if (unsent.length) {
        // A deploy asked for since the wait began that went out without the commit sent the head of a checkout that
        // had not pulled it.
        const why = unsent.map((d) => {
          const row = rows.find((r) => r.name === d.target);
          const newest = [...(row?.history ?? []), ...(row?.live ? [row.live] : []), ...(row?.open ? [row.open] : [])]
            .filter((x) => x.sha && (x.created_at ?? 0) >= clock.start).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
          return newest
            ? `${d.target} ${newest.short_id} sent ${newest.sha!.slice(0, 7)}, so the checkout that publishes it may be behind origin/${input.base}`
            : `cast deploy sent no deploy of ${d.target} (${ended.get(d.target)!.last})`;
        });
        return { code: 1, line: `No deploy carries ${short}: ${why.join("; ")}.` };
      }
      for (const s of states.values()) if (s.state === "live") live.set(s.target, s.deploy.short_id);
      if (plan.duties.every((d) => live.has(d.target))) return { code: 0, line: `Live: ${short} on ${plan.duties.map((d) => `${d.target} ${live.get(d.target)}`).join(", ")}.${tail}` };
      const ciWords = async (at: string, g: CiGate, verdict: MainCi) => {
        if (verdict.state !== "failed") return verdict.state === "running" ? "running" : "no CI yet";
        const since = await io.redSince(at, g);
        return `red${since ? ` since ${since}` : ""}: ${verdict.red.join(", ") || "a check"}`;
      };
      const batch: string[] = [];
      let started = false;
      for (const d of plan.duties) {
        const s = states.get(d.target)!;
        if (s.state === "live") continue;
        const unasked = d.action === "send" && !sent.has(d.target) && s.state === "waiting";
        // A deploy sends main's head (DP13), so the CI that gates it is CI on that head, not on the merged commit.
        const ciSha = s.state === "deploying" ? s.deploy.sha ?? head : head;
        const verdict = d.ci && ciSha && (s.state === "deploying" || d.how === "auto" || s.state === "waiting") ? await ciAt(ciSha, d.ci) : null;
        // Sent in the same `cast deploy` as an `after` target the run sends, it goes out once that one is live: the
        // release orders them. One the run does not send holds it unsent until it is live with the commit.
        const notLive = d.after.filter((a) => sends.has(a) && !live.has(a));
        const heldBy = d.after.filter((a) => !sends.has(a) && !live.has(a) && !outsideLive.get(a));
        const green = !d.ci || verdict?.state === "passed";
        if (unasked && !heldBy.length && notLive.every((a) => batch.includes(a)) && green && !input.once) batch.push(d.target);
        // Its deadline starts once it can go out (every `after` target live with the commit, whoever sends it, and,
        // when gated, main green), so a target red main or an `after` holds does not spend it waiting. A person who
        // never sends an `after` target ends the wait at that target's own deadline, and the cap bounds the rest.
        const ready = s.state === "deploying" || (!notLive.length && !heldBy.length && green);
        if (ready && clock.since[d.target] === undefined) { clock.since[d.target] = now; started = true; }
        if (heldBy.length && s.state !== "deploying") said.set(d.target, { words: `held until ${heldBy.join(", ")} ${heldBy.length > 1 ? "are" : "is"} live with ${short}` });
        else if (verdict && verdict.state !== "passed") said.set(d.target, { words: `waiting on main CI at ${ciSha!.slice(0, 7)}`, detail: await ciWords(ciSha!, d.ci!, verdict) });
        else if (s.state === "deploying") said.set(d.target, { words: `${s.deploy.short_id} sending ${short}` });
        else if (notLive.length) said.set(d.target, { words: `waiting for ${notLive.join(", ")} to go live first` });
        else if (d.how === "others") said.set(d.target, { words: `waiting for ${d.by} to send it` });
        else if (d.how === "release") said.set(d.target, { words: d.action === "send" ? `asking for a deploy of ${short}` : `waiting for a deploy that carries ${short}` });
        else if (d.how === "push") said.set(d.target, { words: `waiting for its push deploy to carry ${short}` });
        else said.set(d.target, { words: `waiting for the server to send ${short} once main CI is green` });
      }
      if (started) io.clock.save(clock);
      if (batch.length) {
        io.progress(`Sending ${batch.join(", ")} for ${short}.`);
        for (const t of batch) sent.set(t, null);
        const done = (r: { code: number; last: string }) => { for (const t of batch) sent.set(t, r); };
        io.send(batch).then(done, (err) => done({ code: 1, last: err instanceof Error ? err.message : String(err) }));
      }
    }
    const waiting = plan.duties.filter((d) => !live.has(d.target));
    const overCap = now - clock.start > DEPLOY_WAIT_CAP_MS;
    const missed = waiting.filter((d) => overCap || (clock.since[d.target] !== undefined && now - clock.since[d.target] > d.deadlineMs));
    if (missed.length) {
      const liveNow = plan.duties.filter((d) => live.has(d.target)).map((d) => `${d.target} ${live.get(d.target)}`);
      const after = (d: Duty) => (clock.since[d.target] !== undefined && now - clock.since[d.target] > d.deadlineMs ? `after ${minutes(d.deadlineMs)}` : `after ${minutes(DEPLOY_WAIT_CAP_MS)}, the longest a run waits`);
      const stuck = `Deploy stuck: ${missed.map((d) => `${d.target} is not live with ${short} ${after(d)} (last: ${words(d.target)})`).join("; ")}.${liveNow.length ? ` Live: ${liveNow.join(", ")}.` : ""}`;
      clock.stuck = true;
      io.clock.save(clock);
      await io.block(`${stuck} Send it again from the Deploys page or with \`cast deploy ${missed.map((d) => d.target).join(" ")}\`.`).catch(() => {});
      return { code: 5, line: stuck };
    }
    // Before a target can go out its own deadline has not started: the line says how long it has been held, and what
    // it will get once it can go.
    const clockOf = (d: Duty) => (clock.since[d.target] !== undefined ? `${minutes(now - clock.since[d.target])} of ${minutes(d.deadlineMs)}` : `held ${minutes(now - clock.start)}, then ${minutes(d.deadlineMs)}`);
    const next = rows
      ? plan.duties.map((d) => `${d.target}: ${live.has(d.target) ? `live in ${live.get(d.target)}` : words(d.target, clockOf(d))}`).join("; ")
      : `Cannot read the deploy targets (cast line deploy targets --json, from the server) for ${waiting.map((d) => d.target).join(", ")}; trying again (${minutes(now - clock.start)} in).`;
    if (next !== line) io.progress((line = next));
    if (input.once) return { code: 3, line };
    await io.sleep(input.intervalMs);
  }
}

// ── the station, wired to this checkout ─────────────────────────────────────

export type AwaitDeployOptions = { sha?: string; merge?: string; base: string; branch?: string; interval: string; once?: boolean; run?: string; node?: string; task?: string; files?: string; except?: string; send?: string };

/** What `cast flow await-deploy` needs from flowCommand: a cast call and a server post. */
export type AwaitDeployEnv = {
  cwd: string;
  cast: (args: string[]) => Promise<{ code: number; out: string; err: string }>;
  post: (path: string, body: Record<string, unknown>) => Promise<unknown>;
};

/** How long one git fetch, targets read or CI read may take before the poll moves on without it. */
const CALL_MS = 60_000;

/** `cast flow await-deploy`: the deploy segment's parked station. Prints the verdict last and returns the exit code. */
export async function runAwaitDeploy(opts: AwaitDeployOptions, env: AwaitDeployEnv): Promise<number> {
  const { cwd } = env;
  const merge = opts.merge ? readMerge(opts.merge) : null;
  const sha = await mergedSha(opts, merge, (run) => env.post("/cli/workflow-runs/get", { run_id: run }));
  const fromRun = (opts.files ?? "").split(/\s+/).filter(Boolean);
  const merged = await mergedCommit(cwd, sha, opts.base, fromRun.length ? fromRun : merge?.files);
  // Exit 4 is Not merged; a station that could not read origin failed, and says why.
  if ("error" in merged) { console.log(merged.error); return merged.unread ? 1 : 4; }
  await recordMergedSha(opts, merged.sha, env.post, (l) => console.error(l));

  const { checkoutTargets } = await import("../lineDeploy.js");
  const { loadLineProfile } = await import("../lineProfile.js");
  const line = (() => { try { return loadLineProfile(cwd).profile.deploy; } catch { return null; } })();
  let declared: DeployTarget[];
  try { declared = await checkoutTargets(cwd); } catch (err) { console.log(`Cannot read this checkout's deploy targets: ${err instanceof Error ? err.message : String(err)}`); return 1; }
  const plan = deployDuties(declared, merged.files, { except: (opts.except ?? "").split(/[\s,]+/).filter(Boolean), held: lineHeld(line), send: opts.send === "release" });
  // A finished verdict on a commit never changes, so looking back for where main went red asks GitHub once per commit.
  const verdicts = new Map<string, MainCi>();
  const ciOf = async (at: string, gate: CiGate) => {
    const key = `${at} ${gate.workflow ?? "*"}`;
    const known = verdicts.get(key);
    if (known) return known;
    const verdict = await mainCiAt(cwd, at, gate);
    if (verdict.state === "passed" || verdict.state === "failed") verdicts.set(key, verdict);
    return verdict;
  };
  const clockFile = opts.merge ? path.join(path.dirname(opts.merge), "deploy-clock.json") : null;
  const { resolveCastInvocation } = await import("../castInvocation.js");
  const castCmd = resolveCastInvocation();

  const io: DeployWaitIO = {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    mainHead: async () => {
      await within("git", ["-C", cwd, "fetch", "-q", "origin", opts.base], cwd, CALL_MS);
      const r = await within("git", ["-C", cwd, "rev-parse", `origin/${opts.base}`], cwd, CALL_MS);
      return r.code === 0 ? r.out.trim() || null : null;
    },
    targets: async () => {
      const r = await within(castCmd.cmd, [...castCmd.prefixArgs, "line", "deploy", "targets", "--json"], cwd, CALL_MS);
      try { return JSON.parse(r.out).targets ?? []; } catch { return null; }
    },
    carries: (deployed) => holds(cwd, merged.sha, deployed),
    mainCi: ciOf,
    redSince: (at, gate) => firstRed(cwd, at, (c) => ciOf(c, gate)),
    send: (targets) => sendDetached(cwd, targets, merged.sha, opts.merge ? path.dirname(opts.merge) : os.tmpdir()),
    // Inside a run the waiting lines go to the station on the card, and only the verdict is the station's output,
    // which is what a stop and the session's end message quote. At a terminal every line prints.
    progress: (text) => {
      if (!opts.run) console.log(text);
      else if (opts.node) void env.post("/cli/workflow-runs/progress", { run_id: opts.run, current_node_id: opts.node, node_id: opts.node, node_status: "running", result_preview: text }).catch(() => {});
    },
    block: async (text) => { if (opts.task) await env.cast(["task", "comment", opts.task, text, "-t", "blocker"]); },
    clock: {
      load: () => { try { return clockFile ? JSON.parse(fs.readFileSync(clockFile, "utf-8")) : null; } catch { return null; } },
      save: (c) => { if (clockFile) fs.writeFileSync(clockFile, `${JSON.stringify(c)}\n`); },
    },
  };
  const result = await awaitDeploy({ sha: merged.sha, base: opts.base, plan, intervalMs: Math.max(5, Number(opts.interval) || 60) * 1000, once: opts.once }, io);
  console.log(result.line);
  return result.code;
}

/**
 * The commit the run merged: `--sha`, else the merge station's merge.json, else the merge recorded on the run
 * (`run.merge.sha`, which `cast line merge` writes without a merge.json). Undefined when none says so.
 */
export async function mergedSha(opts: Pick<AwaitDeployOptions, "sha" | "run">, merge: { sha?: string } | null, readRun: (run: string) => Promise<unknown>): Promise<string | undefined> {
  if (opts.sha) return opts.sha;
  if (merge?.sha) return merge.sha;
  if (!opts.run) return undefined;
  const read = (await readRun(opts.run).catch(() => null)) as { run?: { merge?: { sha?: string } } } | null;
  return read?.run?.merge?.sha || undefined;
}

/**
 * Put a merged sha this station found on origin's base on the run as its merge (landed.ts recordMerge), so the card reads
 * it as landed. A change merged by its own script writes merge.json and never posts the record; without this its run
 * at Deploy had no merge on it. Observed: it spends no merge allowance, and a merge the Merge station recorded stays.
 */
export async function recordMergedSha(opts: Pick<AwaitDeployOptions, "run" | "branch" | "base">, sha: string, post: AwaitDeployEnv["post"], log: (line: string) => void): Promise<"recorded" | "already" | "failed" | null> {
  if (!opts.run) return null;
  const { recordMerge } = await import("./landed.js");
  return recordMerge(post, { run_id: opts.run, sha, branch: opts.branch || sha, into: opts.base }, log);
}

function readMerge(file: string): { sha?: string; files?: string[] } | null {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
}

/** A command's exit code and stdout, killed after `ms` so a hung fetch or read cannot hold the poll. */
function within(cmd: string, args: string[], cwd: string, ms: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), ms);
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => { clearTimeout(timer); resolve({ code: 1, out: "" }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out }); });
  });
}

/**
 * Where main went red: the oldest commit of the red run that main's first-parent history ends in at `sha`, looking at
 * most 30 commits back; commits with no verdict yet are passed over. The seam a recorded culprit fills later.
 */
async function firstRed(cwd: string, sha: string, ciOf: (at: string) => Promise<MainCi>): Promise<string | null> {
  const shas = (await gitTry(cwd, ["rev-list", "--first-parent", "--max-count=30", sha]))?.split("\n").filter(Boolean) ?? [];
  let first: string | null = null;
  for (const c of shas) {
    const verdict = await ciOf(c);
    if (verdict.state === "passed") break;
    if (verdict.state === "failed") first = c;
  }
  return first ? first.slice(0, 7) : null;
}

type WorkflowRun = { databaseId: number; workflowDatabaseId?: number; workflowName: string; status: string; conclusion: string | null; startedAt: string };

/**
 * Main CI on a commit as a gate reads it: the newest run of the workflow it names, or of every workflow but the
 * deploy workflows it excludes, the way the target's own `ci` step and the server's auto rule decide. A workflow's
 * conclusion, not each job's, so an advisory job (continue-on-error) that fails holds nothing. The red jobs are the
 * failed jobs of the failed runs.
 */
export async function mainCiAt(cwd: string, sha: string, gate: CiGate, gh: (args: string[]) => Promise<{ code: number; out: string }> = (args) => within("gh", args, cwd, CALL_MS)): Promise<MainCi> {
  const list = await gh(["run", "list", "--commit", sha, ...(gate.workflow ? ["--workflow", gate.workflow] : []), "--limit", "50", "--json", "databaseId,workflowDatabaseId,workflowName,status,conclusion,startedAt"]);
  let runs: WorkflowRun[] = [];
  try { runs = list.code === 0 ? JSON.parse(list.out) : []; } catch { /* no verdict */ }
  if (!gate.workflow && gate.exclude?.length) {
    // A run names its workflow by id; the workflow list maps each id to the file deploy.toml names.
    const wf = await gh(["workflow", "list", "--all", "--json", "id,path"]);
    let flows: Array<{ id: number; path: string }> = [];
    try { flows = wf.code === 0 ? JSON.parse(wf.out) : []; } catch { /* none to drop */ }
    const dropped = new Set(flows.filter((f) => gate.exclude!.some((x) => f.path === x || f.path.endsWith(`/${x}`))).map((f) => f.id));
    runs = runs.filter((r) => r.workflowDatabaseId === undefined || !dropped.has(r.workflowDatabaseId));
  }
  const newest = new Map<string, WorkflowRun>();
  for (const r of runs) if (!newest.has(r.workflowName) || newest.get(r.workflowName)!.startedAt < r.startedAt) newest.set(r.workflowName, r);
  if (!newest.size) return { state: "none", red: [] };
  const failed = [...newest.values()].filter((r) => r.status === "completed" && !["success", "skipped", "neutral"].includes(r.conclusion ?? ""));
  if (failed.length) {
    const red: string[] = [];
    for (const r of failed) {
      const jobs = await gh(["run", "view", String(r.databaseId), "--json", "jobs", "--jq", ".jobs[] | select(.conclusion == \"failure\") | .name"]);
      const names = jobs.code === 0 ? jobs.out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
      red.push(...(names.length ? names : [r.workflowName]));
    }
    return { state: "failed", red };
  }
  return { state: [...newest.values()].some((r) => r.status !== "completed") ? "running" : "passed", red: [] };
}

/**
 * `cast deploy <targets> --carrying <sha>` in its own process group, its output in a log beside the run's files: a release
 * already sending (a CLI cut, an OTA) runs to its end even when the station stops waiting or is killed at its timeout.
 */
async function sendDetached(cwd: string, targets: string[], sha: string, logDir: string): Promise<{ code: number; last: string }> {
  const { resolveCastInvocation } = await import("../castInvocation.js");
  const { cmd, prefixArgs } = resolveCastInvocation();
  const log = path.join(logDir, `deploy-send-${sha.slice(0, 10)}.log`);
  const fd = fs.openSync(log, "a");
  const child = spawn(cmd, [...prefixArgs, "deploy", ...targets, "--carrying", sha], { cwd, env: process.env, detached: true, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  child.unref();
  const code = await new Promise<number>((resolve) => { child.on("error", () => resolve(1)); child.on("exit", (c) => resolve(c ?? 1)); });
  const last = fs.readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).slice(-3).join(" | ");
  return { code, last: last || `exited ${code}` };
}
