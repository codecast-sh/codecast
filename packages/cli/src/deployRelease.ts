// A release (docs/architecture/deploys.md DP15): send every deploy target main
// has moved past, in the order the targets declare, and wait until each is live.
//
//   cast deploy                 every `release` target main moved past, and the `push` targets it waits on
//   cast deploy cli mobile      those targets, whatever their policy
//   cast deploy --files ...     only the targets these files touch (a change flow's Deploy stage)
//
// The checkout's .codecast/deploy.toml is the authority for what each target is
// and how it goes out; the server says what runs on each (its live deploy).
// Every send is a deploy object (dp-N) running the shipped line-deploy graph, the
// same path as a target's Deploy button, so each one shows on the Deploys page
// with its steps. Nothing here names a project's tools.

import { releaseOrder, type DeployTarget } from "@codecast/shared/contracts/deployTargets";
import { holds, targetState, targetTouches, type DeployTargetRow } from "./workflow/awaitDeploy.js";
import { git, gitTry } from "./wipSnapshot.js";

/** A target as the server's targets read lists it: what runs there and who publishes it. */
export type ServerTarget = DeployTargetRow & { device_id?: string | null; root?: string | null; policy?: string };

export type PlanStep = {
  target: string;
  /** send: this release sends it. wait: it deploys itself (a push target), so the release waits for it. skip: left alone. */
  action: "send" | "wait" | "skip";
  why: string;
  /** Targets of this release it goes after. */
  after: string[];
  /** Commits since its live deploy that touch it; null when that is unknown. */
  commits: number | null;
};

export type ReleaseInput = {
  declared: DeployTarget[];
  server: ServerTarget[];
  /** The commit the release makes live: main's head on origin, or a landed change's commit. */
  sha: string;
  /** Targets named on the command line: sent whatever their policy. */
  named?: string[];
  /** Targets to leave alone. */
  except?: string[];
  /** A change's files: only targets they touch take part. */
  files?: string[];
  /** Commits after `from` up to the release's sha touching these paths past `unless`; null when `from` is not in this checkout. */
  commitsSince: (from: string, paths: string[], unless: string[]) => Promise<number | null>;
  /** Whether a deployed sha already holds the release's sha. */
  carries: (deployed: string) => Promise<boolean>;
};

/** What a release does with each target, in the order it sends them. */
export async function planRelease(input: ReleaseInput): Promise<PlanStep[]> {
  const named = new Set((input.named ?? []).map((n) => n.toLowerCase()));
  for (const n of named) if (!input.declared.some((t) => t.name === n)) throw new Error(`No target ${n} in this checkout's .codecast/deploy.toml (it declares ${input.declared.map((t) => t.name).join(", ") || "none"})`);
  const out: PlanStep[] = [];
  for (const t of releaseOrder(input.declared)) {
    const row = input.server.find((s) => s.name === t.name);
    const step = (action: PlanStep["action"], why: string, commits: number | null = null): PlanStep => ({ target: t.name, action, why, after: t.after ?? [], commits });
    if (named.size && !named.has(t.name)) { out.push(step("skip", "not named")); continue; }
    if (input.except?.includes(t.name)) { out.push(step("skip", "left out on purpose")); continue; }
    if (input.files && !targetTouches(t, input.files)) { out.push(step("skip", t.unless?.length ? "the change touches none of its paths, past what it exempts (tests)" : "the change touches none of its paths")); continue; }
    if (!named.size && t.runs === "here" && t.policy !== "release") {
      out.push(step("skip", t.policy === "auto" ? "the server sends it when CI on main is green" : `goes out on a press: cast deploy ${t.name}`));
      continue;
    }
    if (!row) { out.push(step("skip", "not published: cast line deploy targets --publish")); continue; }
    const state = await targetState(row, input.carries);
    if (state.state === "live") { out.push(step("skip", `already live (${state.deploy.short_id})`)); continue; }
    const liveSha = row.live?.sha ?? null;
    const commits = liveSha ? await input.commitsSince(liveSha, t.paths, t.unless ?? []) : null;
    if (commits === 0) { out.push(step("skip", "nothing waiting: no commit since its live deploy touches it", 0)); continue; }
    const waiting = commits === null ? (liveSha ? "its live deploy is not in this checkout's history" : "nothing recorded live") : `${commits} commit${commits === 1 ? "" : "s"} waiting`;
    if (t.runs === "push") out.push(step("wait", `deploys itself on push; ${waiting}`, commits));
    else if (state.state === "deploying") out.push(step("wait", `${state.deploy.short_id} is already sending it`, commits));
    else out.push(step("send", waiting, commits));
  }
  // An `after` the release does not touch is not waited on.
  const inPlay = new Set(out.filter((s) => s.action !== "skip").map((s) => s.target));
  return out.map((s) => ({ ...s, after: s.after.filter((a) => inPlay.has(a)) }));
}

export type TargetResult = { target: string; status: "live" | "failed" | "skipped"; deploy?: string; sha?: string | null; version?: string | null; note?: string };

export type ReleaseIO = {
  /** Ask for a deploy of a target at main's head. `here`: this machine runs it; else its publishing machine does. */
  request: (target: string, here: boolean) => Promise<{ short_id: string }>;
  /** Run a deploy's line-deploy graph on this machine, in this checkout; resolves with its exit code. */
  run: (deploy: string, target: string) => Promise<number>;
  /** One deploy as the server holds it. */
  read: (deploy: string) => Promise<{ status: string; sha?: string | null; version?: string | null; note?: string | null } | null>;
  /** The targets as the server holds them now. */
  targets: () => Promise<ServerTarget[]>;
  carries: (deployed: string) => Promise<boolean>;
  /** Whether this machine publishes the target, so it runs the send itself. */
  publishedHere: (t: ServerTarget) => boolean;
  log: (target: string, line: string) => void;
  sleep: (ms: number) => Promise<void>;
  pollMs?: number;
  /** How long a wait on another machine's deploy, or a push target, may take. */
  waitMs?: number;
};

const OPEN = new Set(["requested", "running"]);

/**
 * Carry out a plan: each `send` target once every target it goes after is live, the rest side by side; each `wait`
 * target until a live deploy holds the release's sha. A target whose `after` failed is not sent.
 */
export async function runRelease(plan: PlanStep[], io: ReleaseIO): Promise<TargetResult[]> {
  const done = new Map<string, Promise<TargetResult>>();
  const pollMs = io.pollMs ?? 20_000;
  const waitMs = io.waitMs ?? 90 * 60_000;

  const awaitDeploy = async (target: string, deploy: string): Promise<TargetResult> => {
    for (let waited = 0; waited <= waitMs; waited += pollMs) {
      const d = await io.read(deploy);
      if (d && !OPEN.has(d.status)) return { target, status: d.status === "live" ? "live" : "failed", deploy, sha: d.sha, version: d.version, ...(d.note ? { note: d.note } : {}) };
      await io.sleep(pollMs);
    }
    return { target, status: "failed", deploy, note: `${deploy} was not live within ${Math.round(waitMs / 60_000)} minutes` };
  };

  const awaitLive = async (target: string): Promise<TargetResult> => {
    for (let waited = 0; waited <= waitMs; waited += pollMs) {
      const row = (await io.targets()).find((t) => t.name === target);
      const s = row ? await targetState(row, io.carries) : null;
      if (s?.state === "live") return { target, status: "live", deploy: s.deploy.short_id, sha: s.deploy.sha };
      if (s?.state === "failed") return { target, status: "failed", deploy: s.deploy.short_id, note: s.deploy.note ?? undefined };
      await io.sleep(pollMs);
    }
    return { target, status: "failed", note: `not live within ${Math.round(waitMs / 60_000)} minutes` };
  };

  const send = async (step: PlanStep): Promise<TargetResult> => {
    const row = (await io.targets()).find((t) => t.name === step.target);
    if (!row) return { target: step.target, status: "failed", note: "not published" };
    const here = io.publishedHere(row);
    let asked: { short_id: string };
    try {
      asked = await io.request(step.target, here);
    } catch (err) {
      // Another release is sending it: that deploy may already carry this sha; if not, send again once it ends.
      const open = row.open?.short_id;
      if (!open) return { target: step.target, status: "failed", note: err instanceof Error ? err.message : String(err) };
      io.log(step.target, `${open} is already going out; waiting for it`);
      const prior = await awaitDeploy(step.target, open);
      if (prior.status === "live" && prior.sha && (await io.carries(prior.sha))) return prior;
      asked = await io.request(step.target, here);
    }
    io.log(step.target, `${asked.short_id}: sending${here ? "" : " from the machine that publishes it"}`);
    if (!here) return awaitDeploy(step.target, asked.short_id);
    const code = await io.run(asked.short_id, step.target);
    const d = await io.read(asked.short_id);
    if (d?.status === "live") return { target: step.target, status: "live", deploy: asked.short_id, sha: d.sha, version: d.version, ...(d.note ? { note: d.note } : {}) };
    return { target: step.target, status: "failed", deploy: asked.short_id, note: d?.note ?? `exited ${code}` };
  };

  const start = (step: PlanStep): Promise<TargetResult> => {
    const existing = done.get(step.target);
    if (existing) return existing;
    const p = (async (): Promise<TargetResult> => {
      if (step.action === "skip") return { target: step.target, status: "skipped", note: step.why };
      const deps = await Promise.all(step.after.map((a) => start(plan.find((s) => s.target === a)!)));
      const blocked = deps.find((d) => d.status === "failed");
      if (blocked) return { target: step.target, status: "failed", note: `not sent: ${blocked.target} did not go live` };
      if (step.after.length) io.log(step.target, `${step.after.join(", ")} live; going on`);
      return step.action === "wait" ? awaitLive(step.target) : send(step);
    })();
    done.set(step.target, p);
    return p;
  };

  return Promise.all(plan.map(start));
}

/** The plan in words, for `cast deploy --dry-run` and before a release starts. */
export function formatPlan(sha: string, plan: PlanStep[]): string {
  const width = Math.max(...plan.map((s) => s.target.length), 6);
  const word = { send: "send", wait: "wait", skip: "skip" };
  const lines = plan.map((s) => `  ${word[s.action]}  ${s.target.padEnd(width)}  ${s.why}${s.after.length ? `; after ${s.after.join(", ")}` : ""}`);
  const acting = plan.filter((s) => s.action !== "skip").length;
  return [`Release of ${sha.slice(0, 10)}: ${acting ? `${acting} target${acting === 1 ? "" : "s"}` : "nothing to deploy"}`, ...lines].join("\n");
}

/** How each target ended, one line each. */
export function formatResults(results: TargetResult[]): string {
  const width = Math.max(...results.map((r) => r.target.length), 6);
  return results.map((r) => {
    if (r.status === "skipped") return `  -     ${r.target.padEnd(width)}  ${r.note ?? ""}`;
    const what = [r.deploy, r.sha ? r.sha.slice(0, 10) : null, r.version].filter(Boolean).join(" ");
    return `  ${r.status === "live" ? "live" : "FAIL"}  ${r.target.padEnd(width)}  ${what}${r.note ? `  ${r.note.split("\n")[0]}` : ""}`;
  }).join("\n");
}

/** Commits after `from` up to `sha` touching any of `paths` (every path when none) past `unless`, read in `cwd`. */
export async function commitsSince(cwd: string, from: string, sha: string, paths: string[], unless: string[] = []): Promise<number | null> {
  if ((await gitTry(cwd, ["cat-file", "-e", `${from}^{commit}`])) === null) return null;
  if ((await gitTry(cwd, ["merge-base", "--is-ancestor", from, sha])) === null) return null;
  const specs = [...paths.map((p) => `:(glob)${p}`), ...unless.map((p) => `:(glob,exclude)${p}`)];
  const out = await git(cwd, ["rev-list", "--count", `${from}..${sha}`, ...(specs.length ? ["--", ...specs] : [])]);
  return Number(out.trim()) || 0;
}

export { holds };
