/**
 * The shared typecheck's capacity: how many watchers fit this machine (a
 * count and, when measured, memory), who makes room, and the queue an ask
 * waits in for a slot. Split out of check.ts, which re-exports it; the two
 * import each other's functions, called only after both have loaded.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { machineCap } from "./machineCaps.js";
import { thisMachineTooSmall } from "./repoNeed.js";
import { CheckFailure } from "./checkOutcome.js";
import { isPidAlive } from "./workspace/chrome.js";
import { coldReservationBytes, countFloorWatchers, expectedBytes, learnedSizes, watcherCeilingBytes, budgetBytes, fitsBudget, fmtGb, holdBytes, procTable, readPeaks, reservationBytes, treeRssBytes, type Peak, type ProcTable } from "./watcherMemory.js";
import { checkHome, isWanted, launchdHolds, listWatchers, lockFor, logPath, logWatcherEvent, mainCheckoutOf, readWatchState, removeOwnState, sleep, watchDir, watcherDeath, watcherLabel, type CheckProject, type WatcherStarter, type WatchState } from "./check.js";

/** The line an evicted watcher's log ends with, so an asker still on it is told to ask again (75) rather than of a death (70). */
export const EVICTED_LINE = "stopped to make room for another watcher";

/**
 * What a new watcher must fit within: a count (machineCap("check"), 16 unless
 * set), and, when `budgetBytes` is set, memory: every live watcher's hold
 * plus `needBytes` (watcherMemory.ts). A bare number is a count alone.
 */
export interface Capacity {
  maxWatchers: number;
  /** This many always fit, whatever memory says: the count rule memory admission replaced never admits fewer. */
  minWatchers?: number;
  /** Fit by memory even on an empty machine: for an ask behind the first, which gets no "one always runs" pass. */
  strict?: boolean;
  budgetBytes?: number;
  needBytes?: number;
  holdOf?: (w: WatchState & { dir: string }) => number;
}

/** The repository a tree checks out: its main checkout, else itself. */
const repos = new Map<string, string>();
export function repoOf(root: string): string {
  if (!repos.has(root)) repos.set(root, mainCheckoutOf(root) ?? root);
  return repos.get(root)!;
}

export type MachineCapacity = Capacity & { ceilingBytes: number; coldBytes: number; minWatchers: number; budgetBytes: number };

/**
 * The capacity rule, from its inputs: the machine's memory, the count limits,
 * what each project has been measured to reach, and what each live watcher
 * measures now (null when that cannot be read). Pure, so a scenario can be
 * run with another machine's numbers.
 */
export function capacityFor(input: {
  totalBytes: number;
  maxWatchers: number;
  env?: NodeJS.ProcessEnv;
  /** Peaks of the project asking for a watcher. */
  needPeaks: () => Peak[];
  /** Peaks of a live watcher's project. */
  peaksOf: (w: WatchState & { dir: string }) => Peak[];
  /** p95 of every project measured on this machine, for the estimate of one that is not. */
  learnedP95s: number[];
  measure: (w: WatchState & { dir: string }) => number | null;
}): MachineCapacity {
  const env = input.env ?? process.env;
  const budget = budgetBytes(input.totalBytes, env);
  // A need above the whole budget means "alone" either way; capping it there keeps one project that died of memory
  // from holding every ask queued behind it to a reservation the machine can never offer.
  const ceiling = Math.min(watcherCeilingBytes(env), Math.max(budget, 1));
  const cold = coldReservationBytes(budget, input.learnedP95s, env);
  return {
    maxWatchers: input.maxWatchers,
    minWatchers: Math.min(input.maxWatchers, countFloorWatchers(input.totalBytes)),
    budgetBytes: budget,
    // Lazy: status readers need the budget and holds, not a reservation for a project they are not asking about.
    get needBytes() { return reservationBytes(input.needPeaks(), ceiling, cold); },
    holdOf: (w) => {
      const known = input.peaksOf(w);
      const measured = input.measure(w);
      // Its size unreadable (ps failed or timed out under load) is unknown, not zero: it holds what its project reaches.
      if (measured === null) return Math.max(w.peakRssBytes ?? 0, expectedBytes(known, ceiling, cold));
      return holdBytes(w, measured, known, ceiling, cold);
    },
    ceilingBytes: ceiling,
    coldBytes: cold,
  };
}

/** This machine's capacity for one more watcher of `project` in `root`, measured now. */
export function machineCapacity(root: string, project: string, maxWatchers = machineCap("check"), table?: ProcTable): MachineCapacity {
  const peaksOf = new Map<string, Peak[]>();
  const peaks = (repo: string, p: string) => {
    const key = `${repo}\0${p}`;
    if (!peaksOf.has(key)) peaksOf.set(key, readPeaks(repo, p));
    return peaksOf.get(key)!;
  };
  return capacityFor({
    totalBytes: os.totalmem(),
    maxWatchers,
    needPeaks: () => peaks(repoOf(root), project),
    peaksOf: (w) => peaks(w.repo ?? repoOf(w.root), w.project),
    learnedP95s: learnedSizes().flatMap((l) => (l.warm && l.p95Bytes ? [l.p95Bytes] : [])),
    measure: (w) => {
      table ??= procTable();
      return table.size ? treeRssBytes(w.pid, table) : null;
    },
  });
}

/**
 * Stop the least recently asked watchers until one more fits: watchers
 * between passes first, then passes nobody waits on. Watchers in `protect`
 * (the programs the same `cast check` run already asked for) go last:
 * stopping one only to rebuild it on that run's next ask is pure waste.
 * Returns what was stopped, or null when it cannot fit without stopping a
 * wanted pass (nothing is stopped then). A watcher's state file goes with it,
 * so a later ask for that project starts a fresh one.
 */
export function makeRoom(capacity: number | Capacity, kill: (pid: number) => void = (pid) => process.kill(pid, "SIGTERM"), now = Date.now(), protect: ReadonlySet<string> = new Set(), evict = true): Array<WatchState & { dir: string }> | null {
  const cap: Capacity = typeof capacity === "number" ? { maxWatchers: capacity } : capacity;
  const byAsk = (a: WatchState, b: WatchState) => (a.askedAt ?? a.startedAt) - (b.askedAt ?? b.startedAt);
  const live = listWatchers();
  const holds = new Map(live.map((w) => [w.dir, cap.budgetBytes === undefined ? 0 : cap.holdOf?.(w) ?? 0]));
  const fits = (rest: Array<WatchState & { dir: string }>) =>
    rest.length < cap.maxWatchers && (cap.budgetBytes === undefined || rest.length < (cap.minWatchers ?? 0) || (cap.strict
      ? rest.reduce((a, w) => a + holds.get(w.dir)!, 0) + (cap.needBytes ?? 0) <= cap.budgetBytes
      : fitsBudget(rest.map((w) => holds.get(w.dir)!), cap.needBytes ?? 0, cap.budgetBytes)));
  const stoppable = (ws: Array<WatchState & { dir: string }>) => [...ws.filter((w) => !w.inProgress).sort(byAsk), ...ws.filter((w) => w.inProgress && !isWanted(w, now)).sort(byAsk)];
  const eligible = [...stoppable(live.filter((w) => !protect.has(w.dir))), ...stoppable(live.filter((w) => protect.has(w.dir)))];
  const victims: Array<WatchState & { dir: string }> = [];
  let rest = live;
  while (!fits(rest)) {
    const next = evict ? eligible[victims.length] : undefined;
    if (!next) return null;
    victims.push(next);
    rest = rest.filter((w) => w !== next);
  }
  const held = [...holds.values()].reduce((a, b) => a + b, 0);
  const why = cap.budgetBytes === undefined ? `cap ${cap.maxWatchers}` : `cap ${cap.maxWatchers}, ${fmtGb(held)} reserved of ${fmtGb(cap.budgetBytes)}, need ${fmtGb(cap.needBytes ?? 0)}`;
  // A successor may already hold a victim's dir (a --fresh restart): then the room counted is not there, and nothing is stopped.
  if (victims.some((v) => readWatchState(v.dir)?.pid !== v.pid)) return null;
  for (const victim of victims) {
    try {
      fs.appendFileSync(logPath(victim.dir), `${EVICTED_LINE} (${why})\n`);
    } catch {}
    try {
      kill(victim.pid);
    } catch {}
    removeOwnState(victim.dir, victim.pid);
    logWatcherEvent("evict", victim, `asked ${Math.round((now - (victim.askedAt ?? victim.startedAt)) / 60_000)}m ago, ${live.length} live, ${why}${cap.budgetBytes === undefined ? "" : `, frees ${fmtGb(holds.get(victim.dir)!)}`}`);
  }
  return victims;
}

// ---------------------------------------------------------------------------
// The slot queue: asks that need a new watcher wait their turn, oldest first
// ---------------------------------------------------------------------------

export const queueDir = (): string => path.join(checkHome(), "queue");
const BEHIND_CHECK_MS = 5_000;
/** The longest an ask waits in the queue before it exits 75 (ask again; it keeps its place for QUEUE_PLACE_MS). */
export const QUEUE_WAIT_MS = 3 * 60_000;

/** A capacity that also sets aside room for the ask first in line: its memory and its watcher slot. */
function withHeadNeed(cap: Capacity, headNeed: number): Capacity {
  return { maxWatchers: cap.maxWatchers - 1, minWatchers: cap.minWatchers === undefined ? undefined : cap.minWatchers - 1, budgetBytes: cap.budgetBytes, needBytes: (cap.needBytes ?? 0) + headNeed, holdOf: cap.holdOf, strict: true };
}

interface QueueTicket {
  pid: number;
  root: string;
  project: string;
  at: number;
  file: string;
}

/** Live tickets, oldest first; a ticket whose asker died is cleared. */
export function listQueue(): QueueTicket[] {
  const dir = queueDir();
  if (!fs.existsSync(dir)) return [];
  const out: QueueTicket[] = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      const t = JSON.parse(fs.readFileSync(file, "utf-8")) as Omit<QueueTicket, "file">;
      if (isPidAlive(t.pid)) out.push({ ...t, file });
      else fs.rmSync(file, { force: true });
    } catch {}
  }
  return out.sort((a, b) => a.at - b.at || a.file.localeCompare(b.file));
}

/** How long a program keeps its place in the queue across asks that gave up and asked again. */
export const QUEUE_PLACE_MS = 60 * 60_000;
const queuedAtPath = (dir: string): string => path.join(dir, "queued_at");

/** When this program first joined the queue, so a re-ask keeps its place rather than going to the back. */
function queuePlace(dir: string, now = Date.now()): number {
  try {
    const at = parseInt(fs.readFileSync(queuedAtPath(dir), "utf-8"), 10);
    if (at && now - at < QUEUE_PLACE_MS) return at;
  } catch {}
  fs.writeFileSync(queuedAtPath(dir), String(now));
  return now;
}

/**
 * Start the project's watcher once a slot is free and every earlier ask has
 * had its turn. An ask for a project whose watcher another asker started
 * meanwhile leaves the queue and rides that watcher. Returns whether this
 * call started it.
 */
export async function startWhenSlotFrees(
  target: CheckProject,
  root: string,
  opts: { start: WatcherStarter; note: (line: string) => void; kill: (pid: number) => void; maxWatchers?: number; deadline: number; protect?: ReadonlySet<string>; queueWaitMs?: number },
): Promise<boolean> {
  const project = target.name;
  const dir = watchDir(root, project);
  // A caller's own count (tests) is a count alone; otherwise memory admits, under the machine's count.
  const capacity = (): Capacity => (opts.maxWatchers !== undefined ? { maxWatchers: opts.maxWatchers } : machineCapacity(root, project));
  // A queued ask answers within a few minutes, as 75 with a hint, rather than outlive the caller's own timeout.
  const queueDeadline = Math.min(opts.deadline, Date.now() + (opts.queueWaitMs ?? QUEUE_WAIT_MS));
  let cap: Capacity | null = null;
  fs.mkdirSync(queueDir(), { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const at = queuePlace(dir);
  const file = path.join(queueDir(), `${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, root, project, at }));
  let lastAhead = -1;
  let lastBehindCheck = 0;
  const queuedSince = Date.now();
  try {
    for (;;) {
      // Every wait inside the queue is bounded by the queue's own deadline, so it answers on time.
      const left = () => Math.max(1_000, queueDeadline - Date.now());
      const release = await lockFor(path.join(dir, "start.lock"), { describe: `cast check ${project}`, waitMs: left() });
      try {
        const state = readWatchState(dir);
        if (state && isPidAlive(state.pid)) {
          fs.rmSync(queuedAtPath(dir), { force: true });
          return false;
        }
        const queue = listQueue();
        const ahead = queue.findIndex((t) => t.file === file);
        // The first in line may stop idle watchers to make room. One further back starts only if it fits as things are
        // with the first's need also set aside, so a big program waiting on a busy machine neither holds up a small one
        // that fits now nor is starved by them. It checks without a lock, every few seconds, and locks only to start.
        const fitsBehind = (): boolean => {
          if (Date.now() - lastBehindCheck < BEHIND_CHECK_MS) return false;
          lastBehindCheck = Date.now();
          const head = queue[0];
          if (!head || opts.maxWatchers !== undefined) return false;
          return makeRoom(withHeadNeed(capacity(), machineCapacity(head.root, head.project).needBytes ?? 0), () => {}, Date.now(), opts.protect, false) !== null;
        };
        if (ahead === 0 || (ahead > 0 && fitsBehind())) {
          const releaseCapacity = await lockFor(path.join(checkHome(), "capacity.lock"), { describe: "cast check watcher start", waitMs: Math.min(60_000, left()) });
          try {
            cap = capacity();
            const evicted = makeRoom(ahead === 0 ? cap : withHeadNeed(cap, machineCapacity(queue[0]!.root, queue[0]!.project).needBytes ?? 0), opts.kill, Date.now(), opts.protect, ahead === 0);
            if (evicted) {
              const limit = cap.budgetBytes === undefined ? `under ${cap.maxWatchers} watchers` : `within the ${fmtGb(cap.budgetBytes)} typecheck watchers share`;
              for (const w of evicted) opts.note(`stopped the ${w.project} watcher for ${w.root} (${w.inProgress ? "a pass nobody waits on" : "idle longest"}) to stay ${limit} on this machine`);
              const small = thisMachineTooSmall(root);
              if (small) opts.note(small);
              const logFrom = (() => { try { return fs.statSync(logPath(dir)).size; } catch { return 0; } })();
              // A job still running under this label (a watcher just evicted, still on its way out) would make launchd
              // leave the start alone, and the ask would wait for a watcher that never comes.
              const label = watcherLabel(dir);
              for (const settle = Date.now() + 5_000; Date.now() < settle && launchdHolds(label) === "running"; ) await sleep(250);
              opts.start(root, target);
              logWatcherEvent("start", { project, root });
              fs.rmSync(queuedAtPath(dir), { force: true });
              opts.note(`starting the ${project} typecheck watcher for ${root} (first pass builds the whole program; later asks take seconds)`);
              const deadline = Date.now() + 30_000;
              const live = () => { const s = readWatchState(dir); return !!s && isPidAlive(s.pid); };
              while (Date.now() < deadline && !live()) await sleep(200);
              if (!live()) throw watcherDeath(project, dir, "did not start", logFrom);
              return true;
            }
          } finally {
            releaseCapacity();
          }
        }
        if (ahead !== lastAhead) {
          lastAhead = ahead;
          const live = listWatchers();
          const busy = live.map((w) => w.project).join(", ");
          if (ahead !== 0) cap = capacity();
          cap ??= capacity();
          // Name what actually blocks it: every slot taken, or memory past the count rule's number.
          const room = cap.budgetBytes === undefined || live.length >= cap.maxWatchers ? `the ${cap.maxWatchers} typecheck slot${cap.maxWatchers === 1 ? "" : "s"}` : `typecheck memory (needs ${fmtGb(cap.needBytes ?? 0)} of ${fmtGb(cap.budgetBytes)})`;
          opts.note(ahead === 0
            ? `queued for ${room}: the live watchers hold passes someone is waiting on (${busy}); starting when one finishes (cast queue lists them)`
            : `queued: ${ahead} ask${ahead === 1 ? "" : "s"} ahead for ${room} (${busy ? `${busy}; ` : ""}cast queue lists them)`);
        }
      } finally {
        release();
      }
      if (Date.now() > queueDeadline) throw new CheckFailure(`the ${project} typecheck is still queued after ${Math.round((Date.now() - queuedSince) / 1000)}s: the live watchers hold passes someone is waiting on`, "busy");
      await sleep(1_000);
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
}
