// A change on its way to live (docs/architecture/changes.md): five stages
// that never change, Work, Check, Land, Deploy, Live, whatever carries the
// change (a checkout's uncommitted edits, a branch with or without a pull
// request, a shared checkout's pass, a commit on main), and one `now`: the
// stage that holds it, its state there, the word a reader sees and its tone.
// This file is the only place a lifecycle word or tone is chosen. Pure, with
// relative imports only: the web's chip, grid and pills and the phone's pill all
// read a change through it.
import type { DeployReach, ReachState, TargetReach } from "@codecast/shared/contracts/deployReach";
import { deployElapsed } from "../deploys/deployPill";

export const CHANGE_STAGES = ["work", "check", "land", "deploy", "live"] as const;
export type ChangeStageId = (typeof CHANGE_STAGES)[number];

export const STAGE_LABEL: Record<ChangeStageId, string> = { work: "Work", check: "Check", land: "Land", deploy: "Deploy", live: "Live" };

/**
 * A stage's state. `active`: in motion. `waiting`: its turn in a queue. `you`: a person must act. `back`: sent back to
 * the session that wrote it. `failed`: stopped on a failure. `done`: passed. `skipped`: this change does not pass
 * through it (nothing deploys a repo without targets). `idle`: not reached. `stopped`: closed without landing.
 */
export type StageState = "idle" | "active" | "waiting" | "you" | "back" | "failed" | "done" | "skipped" | "stopped";

/** CH2: one palette for every surface. */
export type ChangeTone = "yellow" | "muted" | "blue" | "orange" | "red" | "green" | "dim";

/** What carries the change. Its glyph and name on the chip. */
export type ChangeVehicle =
  | { kind: "branch"; name: string; worktree?: string | null; pr?: number | null }
  | { kind: "pr"; number: number; branch?: string | null; title?: string | null }
  | { kind: "commit"; sha: string; branch?: string | null }
  /** One session's uncommitted edits in a checkout. */
  | { kind: "edits"; title: string; conversation_id?: string | null; files: number }
  /** A shared checkout's bundle: every session's uncommitted work, shipped in one pass. */
  | { kind: "pass"; folder: string; sessions: number; files: number };

export type ChangeWriter = { conversation_id: string | null; title: string | null; state: "working" | "idle" | "finished" };

export type ChangeFacts = {
  vehicle: ChangeVehicle;
  /** Closed without landing: a pull request closed unmerged, a branch deleted, a pass abandoned. */
  closed?: { at: number } | null;
  work?: {
    /** Uncommitted files. */
    uncommitted: number;
    /** Commits main lacks; null when unknown. */
    ahead: number | null;
    /** On the remote (or handed to a pass): the checkout no longer holds it alone. */
    pushed: boolean;
    writers: ReadonlyArray<ChangeWriter>;
  } | null;
  check?: {
    ci: "none" | "pending" | "success" | "failure";
    /** Failing check names, when red. */
    failing?: ReadonlyArray<string>;
    /** CI passed and how many ran, for the hover line. */
    passed?: number | null;
    /** `required`: a person owes a review nobody has given. */
    review: "none" | "required" | "approved" | "changes";
    /** CI that ran on main after the change landed (a direct push): Check reads it, after Land. */
    after_land?: boolean;
  } | null;
  land?: {
    state: "none" | "conflict" | "behind" | "landed";
    sha?: string | null;
    at?: number | null;
    how?: "merged" | "pushed" | "pass" | null;
  } | null;
  /** A draft pull request: its author is still at it, so nobody else's turn has come. */
  draft?: boolean;
  /** GitHub's auto-merge is on: it lands itself once its requirements pass. */
  auto_merge?: boolean;
  /** Landed, and how far it has gone is still being read: neither live nor touching nothing yet. */
  reach_pending?: boolean;
  /** Landed: how far it has gone toward production (deploys.md DP16); null when it touches no target. */
  reach?: DeployReach | null;
  /** The repository has deploy targets at all; false: landing is the end. */
  deploys?: boolean;
};

/** `line`: the stage's sentence on hover. `short`: two words at most, for a cell of the lifecycle grid. */
export type LifecycleStage = { id: ChangeStageId; label: string; state: StageState; line: string | null; short: string | null };

export type LifecycleNow = {
  stage: ChangeStageId;
  state: StageState;
  /** The words after the name, at most three. A now in motion reads its elapsed time from `since` (nowElapsed). */
  word: string;
  /** A quieter second word the chip shows after a `·`: `1 of 2 live`, a failing check's name. */
  detail: string | null;
  tone: ChangeTone;
  /** When the now began, for its elapsed time; null when settled. */
  since: number | null;
};

export type Lifecycle = { vehicle: ChangeVehicle; stages: LifecycleStage[]; now: LifecycleNow };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The stage state each tone reads as, for a now whose tone follows its state. */
const STATE_TONE: Record<StageState, ChangeTone> = {
  active: "yellow",
  waiting: "muted",
  you: "blue",
  back: "orange",
  failed: "red",
  done: "green",
  skipped: "muted",
  idle: "muted",
  stopped: "dim",
};

/** The name a vehicle reads as on its chip. */
export function vehicleName(v: ChangeVehicle): string {
  switch (v.kind) {
    case "branch": return v.name;
    case "pr": return `#${v.number}`;
    case "commit": return v.sha.slice(0, 7);
    case "edits": return v.title;
    case "pass": return `${v.folder.split("/").filter(Boolean).pop() ?? v.folder} checkout`;
  }
}

function liveCount(targets: ReadonlyArray<TargetReach>) {
  return { live: targets.filter((t) => t.state === "live").length, of: targets.length };
}

/** Each target's one line: `backend live · web deploying`. */
function reachLine(reach: DeployReach): string {
  return reach.targets.map((t) => `${t.target} ${REACH_WORD[t.state]}`).join(" · ");
}

const REACH_WORD: Record<ReachState, string> = {
  live: "live",
  going_out: "deploying",
  queued: "queued",
  failed: "failed",
  rolled_back: "rolled back",
  waiting: "not live yet",
};

function workLine(f: ChangeFacts): string | null {
  const w = f.work;
  if (!w) return null;
  const bits: string[] = [];
  if (w.uncommitted) bits.push(`${plural(w.uncommitted, "file")} uncommitted`);
  if (w.ahead) bits.push(`${plural(w.ahead, "commit")} ahead`);
  if (w.pushed && !w.uncommitted) bits.push("pushed");
  return bits.join(" · ") || null;
}

function checkLine(f: ChangeFacts): string | null {
  const c = f.check;
  if (!c) return null;
  const ci =
    c.ci === "failure" ? (c.failing?.length ? `${c.failing.join(", ")} failed` : "CI failed")
    : c.ci === "pending" ? "CI running"
    : c.ci === "success" ? (c.passed ? `${plural(c.passed, "check")} passed` : "CI passed")
    : null;
  const review = c.review === "approved" ? "review passed" : c.review === "changes" ? "review asked for changes" : c.review === "required" ? "waiting for a reviewer" : null;
  const bits = [ci, review].filter(Boolean) as string[];
  if (c.after_land) bits.push("after it landed");
  return bits.join(" · ") || null;
}

function landLine(f: ChangeFacts): string | null {
  const l = f.land;
  if (!l) return null;
  if (l.state === "landed") {
    const how = l.how === "pushed" ? "Pushed to main" : l.how === "pass" ? "Shipped with the checkout" : "Merged";
    return l.sha ? `${how} as ${l.sha.slice(0, 7)}` : how;
  }
  return ({ none: null, conflict: "Conflicts with main", behind: "Behind main" } as const)[l.state];
}

/** Each stage's two words for a grid cell: what the change holds there. */
function stageShorts(f: ChangeFacts): Record<ChangeStageId, string | null> {
  const w = f.work, c = f.check, l = f.land, r = f.reach;
  const work = !w ? null : w.uncommitted ? plural(w.uncommitted, "file") : w.ahead ? plural(w.ahead, "commit") : w.pushed ? "pushed" : null;
  const check = !c ? null
    : c.ci === "failure" ? (c.failing?.length === 1 ? c.failing[0] : "failed")
    : c.review === "changes" ? "changes asked"
    : c.ci === "pending" ? "running"
    : c.ci === "success" ? (c.passed ? `${c.passed} passed` : "passed")
    : c.review === "approved" ? "reviewed" : null;
  const land = !l ? null : l.state === "landed" ? (l.sha ? l.sha.slice(0, 7) : "on main") : l.state === "none" ? null : landLine(f)?.toLowerCase() ?? null;
  const one = r?.targets.length === 1 ? r.targets[0].target : null;
  const deploy = !r ? null : one ?? `${r.targets.length} targets`;
  const live = !r ? null : one ? (r.targets[0].state === "live" ? one : null) : `${r.targets.filter((t) => t.state === "live").length} of ${r.targets.length}`;
  return { work, check, land, deploy, live };
}

/** The change's stages and its now, at `now`. */
export function changeLifecycle(f: ChangeFacts): Lifecycle {
  const states: Record<ChangeStageId, StageState> = { work: "idle", check: "idle", land: "idle", deploy: "idle", live: "idle" };
  const lines: Record<ChangeStageId, string | null> = { work: workLine(f), check: checkLine(f), land: landLine(f), deploy: null, live: null };
  const shorts = stageShorts(f);
  const set = (upTo: ChangeStageId) => {
    for (const id of CHANGE_STAGES) {
      if (id === upTo) return;
      states[id] = "done";
    }
  };
  const result = (stage: ChangeStageId, state: StageState, word: string, since: number | null = null, tone: ChangeTone = STATE_TONE[state], detail: string | null = null): Lifecycle => {
    set(stage);
    states[stage] = state;
    return {
      vehicle: f.vehicle,
      stages: CHANGE_STAGES.map((id) => ({ id, label: STAGE_LABEL[id], state: states[id], line: lines[id], short: shorts[id] })),
      now: { stage, state, word, tone, since, detail },
    };
  };

  const land = f.land ?? { state: "none" as const };
  const check = f.check ?? null;
  const work = f.work ?? null;

  // Landed: the rest is deploy reach.
  if (land.state === "landed") {
    // CI that ran after a direct push still says what main thinks of it.
    if (check?.after_land && check.ci === "failure") {
      states.land = "done";
      return result("check", "failed", "red on main");
    }
    const reach = f.reach ?? null;
    if (!reach && f.reach_pending) {
      lines.deploy = "Reading its deploys";
      return result("deploy", "idle", "on main", null, "muted");
    }
    if (!reach) {
      states.deploy = "skipped";
      states.live = "skipped";
      lines.deploy = f.deploys === false ? "This repository deploys nothing" : "Touches nothing a target deploys";
      for (const id of ["work", "check", "land"] as const) states[id] = "done";
      return {
        vehicle: f.vehicle,
        stages: CHANGE_STAGES.map((id) => ({ id, label: STAGE_LABEL[id], state: states[id], line: lines[id], short: shorts[id] })),
        now: { stage: "land", state: "done", word: "landed", tone: "green", since: null, detail: null },
      };
    }
    lines.deploy = reachLine(reach);
    const { live, of } = liveCount(reach.targets);
    const lead = reach.targets.find((t) => t.state === reach.state);
    const at = lead?.deploy?.at ?? null;
    const partial = of > 1 && live > 0 ? `${live} of ${of} live` : null;
    switch (reach.state) {
      case "live":
        states.deploy = "done";
        lines.live = of > 1 ? `Live on all ${of} targets` : `Live on ${reach.targets[0]?.target ?? "its target"}`;
        return result("live", "done", "live");
      case "going_out": return result("deploy", "active", "deploying", at, "yellow", partial);
      case "queued": return result("deploy", "waiting", "deploy queued", at);
      case "failed": return result("deploy", "failed", "deploy failed");
      case "rolled_back":
        states.deploy = "done";
        lines.live = "Was live, then rolled back";
        return result("live", "back", "rolled back");
      case "waiting": return result("deploy", "waiting", "not live yet", null, "muted", partial);
    }
  }

  if (f.closed) {
    // Stopped where it was: the stages before stay as they were reached.
    const at: ChangeStageId = check && check.ci !== "none" ? "check" : "work";
    return result(at, "stopped", "closed");
  }

  // On its way to main.
  if (land.state === "conflict") return result("land", "back", "conflicts");
  if (land.state === "behind" && check?.ci !== "failure") return result("land", "back", "behind main");

  if (f.draft && check?.ci !== "failure") return result("check", "waiting", "draft");
  if (check && (check.ci !== "none" || check.review !== "none")) {
    if (check.ci === "failure") return result("check", "failed", "checks failed", null, "red", check.failing?.length === 1 ? check.failing[0] : null);
    if (check.review === "changes") return result("check", "back", "changes asked");
    if (check.ci === "pending") return result("check", "active", "checking");
    if (check.review === "required") return result("check", "you", "needs review");
    // Checks passed and nothing is landing it yet: auto-merge lands it on its own, else a person does.
    return f.auto_merge ? result("land", "active", "landing") : result("land", "you", "ready to land");
  }

  if (work) {
    const working = work.writers.some((w) => w.state === "working");
    if (working) return result("work", "active", "editing");
    if (work.pushed && !work.uncommitted) return result("check", "idle", "not checked", null, "muted");
    if (work.uncommitted || work.ahead) {
      const idle = work.writers.some((w) => w.state === "idle");
      if (idle) return result("work", "waiting", "between turns");
      // Nobody is at it and nothing is taking it out: it waits on whoever ships it, which is nobody's turn by itself.
      return result("work", "waiting", "not shipped");
    }
  }
  return result("work", "idle", "nothing yet", null, "dim");
}

/** How long a now in motion or in a queue has lasted (`6m`), the chip's time after its word; null for any other. */
export function nowElapsed(n: LifecycleNow, at: number): string | null {
  return n.since != null && (n.state === "active" || n.state === "waiting") ? deployElapsed(at - n.since) : null;
}

/** Whether a change has stopped moving: live, landed with nothing to deploy, or closed. Settled chips stop ticking. */
export const lifecycleSettled = (l: Lifecycle) => l.now.state === "done" || l.now.state === "stopped";
