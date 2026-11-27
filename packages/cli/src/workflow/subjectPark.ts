// The run's subject between its turns (docs/architecture/flows.md FL4). While
// the run works on the change without it (a check, a review, a person's card,
// a deploy), the run asks a settled subject's daemon to park it, so a session
// that has nothing to do holds no process. It stays in the inbox: the live run
// is its wake, so it files under Dormant (classifyWorkState's doneRest). And
// once its change is live, a subject with no other work left is retired:
// killed, not told "done", since a send would resume a parked session just to
// read that.
import * as fs from "node:fs";
import * as path from "node:path";
import { git, gitTry } from "../wipSnapshot.js";
import type { DeployTargetRow } from "./awaitDeploy.js";
import type { Subject } from "./subjectStation.js";

type Call = (route: string, body: Record<string, unknown>) => Promise<any>;

/** The subject's inbox row, killed or not, or null when it cannot be read. */
export async function subjectRow(call: Call, subject: Subject): Promise<any | null> {
  const read = await call("/cli/inbox", { session_ids: [subject.conversationId], show_all: true, include_killed: true, limit: 5 });
  return (read?.sessions || []).find((r: any) => r.id === subject.conversationId) ?? null;
}

// Who acts next on it is nobody: it is not working and asks no one anything.
const RESTING = ["done", "dormant", "idle"];

/** Whether the subject has settled: not killed, not working, not asking. A parked one has settled too. */
export function subjectSettled(row: any): boolean {
  return !!row && !row.is_killed && RESTING.includes(row.work_state || "idle");
}

/** Whether there is anything to park: settled, and still holding a live process. */
function parkable(row: any): boolean {
  return subjectSettled(row) && row.is_live === true && row.agent_status !== "hibernated";
}

// The daemon refuses to park a session resumed in the last ten minutes, so asking more often only adds refusals.
const HIBERNATE_RETRY_MS = 5 * 60_000;

export type SubjectParker = { tick(): Promise<void>; pause(): Promise<void>; resume(): void; stop(): Promise<void>; bind(context: Record<string, string>): void };

// Where the run notes that a person took its subject over: the run's context, so a resumed runner keeps it.
const KEPT = "subject_kept";
// When the run began watching its subject (epoch ms), in the run's context so a resume keeps the first one.
const SINCE = "subject_watch_since";

/** A person sent the subject something after the run began watching it, a bare "yes" included
 *  (last_person_turn_at): they are using it, so it is theirs. Every send of the run's own is a machine's (a quiet
 *  brief, a card's answer, the end message), and so is another session's. */
export function personTurnSince(row: any, since: number): boolean {
  return typeof row?.last_person_turn_at === "number" && row.last_person_turn_at > since;
}

/** Whether a person has taken the subject over, noted in the run's context (so a resumed runner keeps to it) or
 *  read off `row` now: the parker checks once a minute, and its last check can miss a message a person sent just
 *  before the run retires the subject. */
export function subjectTakenOver(row: any, context: Record<string, string>): boolean {
  if (context[KEPT] === "1") return true;
  if (!context[SINCE] || !personTurnSince(row, Number(context[SINCE]))) return false;
  context[KEPT] = "1";
  return true;
}

/**
 * Parks the subject while the run does not need it: a check every `intervalMs`
 * (and whenever the runner calls `tick`, before each station), paused while a
 * station of the subject's own runs. The daemon is asked to hibernate a
 * settled, live subject at most every five minutes; a refusal (attached, mid
 * turn, just resumed) is the daemon's call, and the next ask may land. A
 * person who writes to it after the run began keeps it: the run parks it no
 * more and never retires it. Nothing runs until `bind` gives it the run's
 * context, which remembers that across a resume: a resumed runner that
 * checked before reading it would park a session a person kept.
 */
export function startSubjectParker(call: Call, subject: Subject, intervalMs: number, log: (line: string) => void): SubjectParker {
  let paused = false;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let askedAt = 0;
  let context: Record<string, string> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const idle = () => paused || stopped || !context || context[KEPT] === "1";
  const check = async () => {
    const row = await subjectRow(call, subject);
    if (idle() || !row) return;
    if (subjectTakenOver(row, context!)) {
      log(`${subject.shortId} has a person's message since the run began: the run leaves it to them and parks it no more`);
      return;
    }
    if (!parkable(row)) return;
    if (Date.now() - askedAt >= HIBERNATE_RETRY_MS) {
      if (idle()) return;
      askedAt = Date.now();
      const asked = await call("/cli/sessions/hibernate", { session: subject.conversationId });
      log(asked ? `asked ${subject.shortId}'s daemon to park it (it may refuse; the run asks again in 5m)` : `could not ask ${subject.shortId}'s daemon to park it`);
    }
  };
  const tick = (): Promise<void> => {
    if (idle()) return Promise.resolve();
    inFlight ??= check().catch(() => {}).finally(() => { inFlight = null; });
    return inFlight;
  };
  return {
    tick,
    // A station of the subject's own sends it work: no park may land on top of the brief.
    pause: async () => { paused = true; await inFlight; },
    resume: () => { paused = false; },
    stop: async () => { stopped = true; if (timer) clearInterval(timer); await inFlight; },
    bind: (ctx) => {
      context = ctx;
      ctx[SINCE] ??= String(Date.now());
      if (timer || stopped) return;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
  };
}

/**
 * Why the landed change is not live yet, or null once every deploy target its
 * files touch runs a deploy that holds it (a change no target ships is live
 * when it lands). Read once, the way `cast flow await-deploy --once` reads it;
 * targets that cannot be read count as not live, and so does a target the
 * checkout declares (.codecast/deploy.toml) that the server has never listed:
 * nothing has deployed it, so nothing holds the change there.
 */
export async function notLiveYet(cwd: string, landed: { sha: string; files: string[] }, call: Call): Promise<string | null> {
  const { readLocalGitContext } = await import("../prCommand.js");
  const { targetTouches, targetState, holds } = await import("./awaitDeploy.js");
  const repository = readLocalGitContext(cwd).repository;
  if (!repository) return "its deploy targets cannot be read (no GitHub origin)";
  const view = await call("/cli/deploys/targets", { repository });
  if (!Array.isArray(view?.targets)) return "its deploy targets cannot be read";
  const listed = view.targets as DeployTargetRow[];
  const { checkoutTargets } = await import("../lineDeploy.js");
  const unlisted = (await checkoutTargets(cwd).catch(() => [])).filter((d) => !listed.some((t) => t.name === d.name)).map((d) => ({ name: d.name, paths: d.paths }));
  const touched = [...listed, ...unlisted].filter((t) => targetTouches(t.paths, landed.files));
  const states = await Promise.all(touched.map((t) => targetState(t, (sha) => holds(cwd, landed.sha, sha))));
  const waiting = states.filter((s) => s.state !== "live").map((s) => s.target);
  return waiting.length ? `its change is not live yet on ${waiting.join(", ")}` : null;
}

/**
 * Why the subject still has work of its own beside the landed change, or null
 * when it has none: every file it wrote that is changed in `root` reads as the
 * landed commit (or the default branch now) has it. A session with no changed
 * file left has none; an attribution that fails for any other reason counts as
 * work, since retiring a session wrongly loses it.
 */
export async function subjectOtherWork(root: string, subject: Subject, landed: string, upstream: string): Promise<string | null> {
  const { previewSessionChange, NoSessionChange } = await import("./flowChange.js");
  let files: string[];
  let frozen: Map<string, string>;
  try {
    const preview = await previewSessionChange(root, subject.conversationId);
    files = [...preview.paths, ...preview.held.map((h) => h.path)];
    // What the subject's change holds of each file: a file cut to its own lines (ownLines.ts) is that cut, not the
    // checkout's copy, which still holds another session's lines beside them.
    frozen = new Map(preview.frozen.changes.map((c) => [c.path, c.blob ?? ""]));
  } catch (err) {
    if (err instanceof NoSessionChange) return null;
    return `its changes could not be read: ${err instanceof Error ? err.message : String(err)}`;
  }
  const blob = (rev: string, f: string) => gitTry(root, ["rev-parse", "-q", "--verify", `${rev}:${f}`]).then((s) => s?.trim() ?? "");
  const differs: string[] = [];
  for (const f of files) {
    const here = frozen.get(f) ?? (fs.existsSync(path.join(root, f)) ? (await git(root, ["hash-object", "--", f])).trim() : "");
    if (here !== (await blob(landed, f)) && here !== (await blob(upstream, f))) differs.push(f);
  }
  return differs.length ? `it has other changes: ${differs.join(", ")}` : null;
}
