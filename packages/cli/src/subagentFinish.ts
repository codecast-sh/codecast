// A Claude Code Task subagent that has finished is marked `completed`, softly:
// a parent can resume a finished subagent with SendMessage, so new transcript
// lines put it back to `active`.
//
// Claude Code says a Task subagent is done by adding `"finished": true` to the
// `agent-<id>.meta.json` beside its transcript. Nothing watches that file, and
// in about 6% of runs it is written after the transcript's last line, so the
// check runs on a quiet timer after each transcript pass rather than on the
// pass itself. `finished` is not cleared when the parent resumes the agent, so
// it counts only when the meta was written around the transcript's end.
// Teammates (meta carries `teamName`) never finish this way and are left alone.

import { promises as fsp } from "node:fs";
import * as path from "node:path";

/** How far the transcript may run past the meta write and still count as the
 *  run the meta describes. A resumed run appends well after a stale meta. */
export const FINISH_META_SLACK_MS = 30_000;
/** How long a subagent transcript must be quiet before its meta is read. */
export const FINISH_QUIET_MS = 15_000;

export interface SubagentFileState {
  /** Parsed meta.json, or null when it is missing or unreadable. */
  meta: unknown;
  metaMtimeMs: number;
  jsonlMtimeMs: number;
}

export interface SubagentStatusSink {
  markSessionCompleted(conversationId: string): Promise<void>;
  markSessionActive(conversationId: string): Promise<void>;
}

function taskSubagentMeta(meta: unknown): { finished?: unknown } | null {
  if (!meta || typeof meta !== "object") return null;
  if ((meta as { teamName?: unknown }).teamName !== undefined) return null;
  return meta as { finished?: unknown };
}

/** True when the meta says the Task subagent finished and was written around
 *  the end of the transcript, not before a later resumed run. */
export function subagentLooksFinished(state: SubagentFileState): boolean {
  const meta = taskSubagentMeta(state.meta);
  return meta?.finished === true && state.metaMtimeMs >= state.jsonlMtimeMs - FINISH_META_SLACK_MS;
}

export function isSubagentTranscriptPath(filePath: string): boolean {
  return filePath.endsWith(".jsonl") && filePath.split(path.sep).includes("subagents");
}

async function readSubagentFileState(filePath: string): Promise<SubagentFileState | null> {
  const metaPath = filePath.replace(/\.jsonl$/, ".meta.json");
  try {
    const [metaStat, jsonlStat, raw] = await Promise.all([fsp.stat(metaPath), fsp.stat(filePath), fsp.readFile(metaPath, "utf8")]);
    return { meta: JSON.parse(raw), metaMtimeMs: metaStat.mtimeMs, jsonlMtimeMs: jsonlStat.mtimeMs };
  } catch {
    return null;
  }
}

interface Entry {
  conversationId?: string;
  sink?: SubagentStatusSink;
  timer?: unknown;
  /** Bumped by every pass, so a check that started before new lines gives up. */
  generation: number;
  /** This daemon marked it completed and has not seen it grow since. */
  completed: boolean;
  /** This daemon knows the row is active (it created it, or asserted it). */
  confirmed: boolean;
  /** Status writes for one file go out in order. */
  queue: Promise<void>;
}

export interface SubagentFinishDeps {
  readState?: (filePath: string) => Promise<SubagentFileState | null>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  quietMs?: number;
}

export class SubagentFinishTracker {
  private readonly entries = new Map<string, Entry>();
  private readonly readState: (filePath: string) => Promise<SubagentFileState | null>;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly quietMs: number;
  private stopped = false;

  constructor(deps: SubagentFinishDeps = {}) {
    this.readState = deps.readState ?? readSubagentFileState;
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    });
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.quietMs = deps.quietMs ?? FINISH_QUIET_MS;
  }

  private entry(filePath: string): Entry {
    let e = this.entries.get(filePath);
    if (!e) {
      e = { generation: 0, completed: false, confirmed: false, queue: Promise.resolve() };
      this.entries.set(filePath, e);
    }
    return e;
  }

  private send(e: Entry, write: (sink: SubagentStatusSink, id: string) => Promise<void>): Promise<void> {
    const sink = e.sink, id = e.conversationId;
    if (!sink || !id) return e.queue;
    e.queue = e.queue.then(() => write(sink, id)).catch(() => {});
    return e.queue;
  }

  /** The row was just created by this daemon, so it is active already. */
  noteCreated(filePath: string): void {
    if (isSubagentTranscriptPath(filePath)) this.entry(filePath).confirmed = true;
  }

  /** A pass synced new lines of `filePath`. Reopens a row this daemon (or an
   *  earlier run) completed, and re-arms the finish check. */
  async noteGrowth(filePath: string, conversationId: string | undefined, sink: SubagentStatusSink): Promise<void> {
    if (this.stopped || !isSubagentTranscriptPath(filePath)) return;
    const e = this.entry(filePath);
    e.generation++;
    if (conversationId) {
      e.conversationId = conversationId;
      e.sink = sink;
    }
    if (e.timer !== undefined) this.clearTimer(e.timer);
    e.timer = this.setTimer(() => {
      e.timer = undefined;
      void this.check(filePath);
    }, this.quietMs);
    if (!e.conversationId) return;

    if (e.completed) {
      e.completed = false;
      e.confirmed = true;
      await this.send(e, (s, id) => s.markSessionActive(id));
      return;
    }
    if (!e.confirmed) {
      // First growth this daemon has seen: an earlier daemon run may have
      // completed it. Only Task subagents (meta present, not a teammate).
      e.confirmed = true;
      const state = await this.readState(filePath);
      if (state && taskSubagentMeta(state.meta)) await this.send(e, (s, id) => s.markSessionActive(id));
    }
  }

  /** The quiet-timer body: mark the row completed if the meta says finished. */
  async check(filePath: string): Promise<void> {
    const e = this.entries.get(filePath);
    if (this.stopped || !e?.conversationId || e.completed) return;
    const generation = e.generation;
    const state = await this.readState(filePath);
    if (this.stopped || e.generation !== generation || e.completed) return;
    if (!state || !subagentLooksFinished(state)) return;
    e.completed = true;
    await this.send(e, (s, id) => s.markSessionCompleted(id));
  }

  stop(): void {
    this.stopped = true;
    for (const e of this.entries.values()) {
      if (e.timer !== undefined) this.clearTimer(e.timer);
      e.timer = undefined;
    }
  }
}
