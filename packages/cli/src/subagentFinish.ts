// A Claude Code Task subagent that has stopped is marked `completed`, softly:
// a parent can resume a stopped subagent with SendMessage, so new transcript
// lines put it back to `active`.
//
// Whether the in-process copy still runs is subagentRunState, read from the
// agent's own two files and its parent's liveness (pl-1134 spike, Claude Code
// 2.1.332). The same answer gates promoting a taken-over child to its own
// process (subagentPromotion.ts), so the row's Working and the promotion agree.
// Nothing watches the meta, so the check runs on a quiet timer after each
// transcript pass rather than on the pass itself. Teammates (meta carries
// `teamName`) are left alone here: they idle inside their lead.

import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { scanOpenBackgroundTasks } from "./backgroundTaskScan.js";
import { claudeSessionProcessAlive } from "./sessionProcessMatcher.js";

/** How long a subagent transcript must be quiet before its state is read. */
export const FINISH_QUIET_MS = 15_000;

export type SubagentRunState = "running" | "stopped";

export interface SubagentRunFacts {
  /** Parsed agent-<id>.meta.json, or null when it is missing or unreadable. */
  meta: unknown;
  /** The agent's own transcript. */
  agentJsonl: string;
  /** A live claude process holds the parent session (claudeSessionProcessAlive). */
  parentAlive: boolean;
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

// The newest user or assistant line. Transcripts also carry api-request*,
// attachment and data-flow-records lines, which say nothing about the run.
function lastMessageLine(jsonl: string): { type: string; message?: { content?: unknown } } | null {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const d = JSON.parse(line);
      if (d?.type === "user" || d?.type === "assistant") return d;
    } catch {
      // a torn tail
    }
  }
  return null;
}

function firstText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const block = content.find((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "text");
  return typeof block?.text === "string" ? block.text : "";
}

/**
 * Whether the in-process copy of a subagent can still take a step. `finished`
 * alone is unsafe: it is written while the agent's own background work still
 * runs (it wakes when that work reports), cleared on every resume and
 * self-wake, and never written by a TaskStop, which leaves an interrupt line
 * instead. A dead parent stops it whatever the files say (orphaned tool
 * subprocesses can still write).
 */
export function subagentRunState(f: SubagentRunFacts): SubagentRunState {
  if (!f.parentAlive) return "stopped";
  const meta = f.meta && typeof f.meta === "object" ? (f.meta as { teamName?: unknown; finished?: unknown }) : null;
  if (meta?.teamName !== undefined) return "running";
  const last = lastMessageLine(f.agentJsonl);
  const interrupted = last?.type === "user" && firstText(last.message?.content).startsWith("[Request interrupted by user");
  if (meta?.finished !== true && !interrupted) return "running";
  if (scanOpenBackgroundTasks(f.agentJsonl).size > 0) return "running";
  return "stopped";
}

export function isSubagentTranscriptPath(filePath: string): boolean {
  return filePath.endsWith(".jsonl") && filePath.split(path.sep).includes("subagents");
}

/** Whether the session a subagent transcript runs under has a live claude
 *  process: <config dir>/projects/<project>/<parent>/subagents/agent-<id>.jsonl,
 *  checked against <config dir>/sessions. */
export function subagentParentAlive(filePath: string): boolean {
  const parts = filePath.split(path.sep);
  const idx = parts.lastIndexOf("subagents");
  if (idx < 4 || parts[idx - 3] !== "projects") return true; // unknown layout: never call it dead
  return claudeSessionProcessAlive(path.join(parts.slice(0, idx - 3).join(path.sep) || path.sep, "sessions"), parts[idx - 1]);
}

export async function readSubagentRunFacts(filePath: string): Promise<SubagentRunFacts | null> {
  let agentJsonl: string;
  try {
    agentJsonl = await fsp.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  let meta: unknown = null;
  try {
    meta = JSON.parse(await fsp.readFile(filePath.replace(/\.jsonl$/, ".meta.json"), "utf8"));
  } catch {
    // no meta yet
  }
  return { meta, agentJsonl, parentAlive: subagentParentAlive(filePath) };
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
  readState?: (filePath: string) => Promise<SubagentRunFacts | null>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  quietMs?: number;
}

export class SubagentFinishTracker {
  private readonly entries = new Map<string, Entry>();
  private readonly readState: (filePath: string) => Promise<SubagentRunFacts | null>;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly quietMs: number;
  private stopped = false;

  constructor(deps: SubagentFinishDeps = {}) {
    this.readState = deps.readState ?? readSubagentRunFacts;
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

  /** The quiet-timer body: the row follows subagentRunState. */
  async check(filePath: string): Promise<void> {
    const e = this.entries.get(filePath);
    if (this.stopped || !e?.conversationId) return;
    const generation = e.generation;
    const state = await this.readState(filePath);
    if (this.stopped || e.generation !== generation) return;
    if (!state || !taskSubagentMeta(state.meta)) return;
    const stopped = subagentRunState(state) === "stopped";
    if (stopped === e.completed) return;
    e.completed = stopped;
    await this.send(e, (s, id) => (stopped ? s.markSessionCompleted(id) : s.markSessionActive(id)));
  }

  stop(): void {
    this.stopped = true;
    for (const e of this.entries.values()) {
      if (e.timer !== undefined) this.clearTimer(e.timer);
      e.timer = undefined;
    }
  }
}
