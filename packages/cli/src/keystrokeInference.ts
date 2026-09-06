// Keystroke inference: the two moments Claude Code reports no hook for.
//
// Claude emits nothing when the user presses Ctrl+C mid-turn, and nothing when
// the user answers an AskUserQuestion. Both are discovered after the fact, from
// the transcript, so the web keeps painting "working" or "waiting for input"
// for the whole flush latency. Where cast can SEE the input bytes it can know
// sooner: the integrated terminal proxy, the remote pane stream, and the keys
// the daemon itself sends.
//
// INFERENCE IS A FALLBACK, NEVER AN AUTHORITY. It arms against a baseline of the
// status row and re-validates every field before it writes, so a real hook or a
// transcript fact that landed meanwhile always wins and the inference stands
// down. It exists to fill a MISSING signal, not to outrank one that arrived.
//
// NOT COVERED, by construction: a pane the human drives from a raw `tmux
// attach`. Those bytes travel from their own terminal into tmux and cast never
// sees them, so such a session keeps the old transcript-latency behaviour.
// Nothing here degrades it, and no amount of tmux polling would recover it —
// tmux does not report the input it delivers.
//
// Modelled on Orca's agent-interrupt-inference.ts / server-status-inference.ts /
// agent-question-answered-intent.ts, re-grounded on codecast's runtime: tmux
// panes rather than node-pty, byte chunks rather than KeyboardEvents, and
// codecast's own AgentStatus vocabulary (ct-49534).

import { MID_TURN_AGENT_STATUSES, STATUS_TRUST_TTL_MS, type AgentStatus } from "@codecast/shared/contracts";
import fs from "fs";
import path from "path";

/** How long an armed interrupt waits for a real hook before it writes. */
export const INTERRUPT_SETTLE_MS = 500;

/** The ask-input sidecar is never deleted, so age is the only freshness signal. */
export const ASK_INPUT_FRESH_MS = 5 * 60_000;

export type InputIntent =
  | { kind: "ctrl-c" }
  | { kind: "escape" }
  | { kind: "enter" }
  | { kind: "digit"; value: number };

/**
 * What one chunk of pane input means, or null when it means nothing to us.
 *
 * Only a chunk that is exactly one keystroke qualifies. A longer chunk is a
 * paste or a burst of typing, and reading an Escape or a digit out of the
 * middle of one would arm the inference on a byte the user never pressed alone.
 */
export function classifyInputBytes(bytes: ArrayLike<number>): InputIntent | null {
  if (bytes.length === 1) {
    const b = bytes[0]! & 0xff;
    if (b === 0x03) return { kind: "ctrl-c" };
    if (b === 0x1b) return { kind: "escape" };
    if (b === 0x0d || b === 0x0a) return { kind: "enter" };
    if (b >= 0x31 && b <= 0x39) return { kind: "digit", value: b - 0x30 };
    return null;
  }
  const text = Array.from(bytes, (b) => String.fromCharCode(b & 0xff)).join("");
  // A CRLF terminal and xterm's CSI-u encoding both spell Enter in more than
  // one byte; every other multi-byte sequence is not a key we act on.
  if (text === "\r\n" || text === "\x1b[13u" || text === "\x1b[13;1u") return { kind: "enter" };
  return null;
}

/** The sidecar's payload once it has passed the freshness bar, else null. */
export function parseAskInputSidecar(
  raw: string,
  mtimeMs: number,
  now: number,
): { questions: any[] } | null {
  if (now - mtimeMs > ASK_INPUT_FRESH_MS) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.questions) && parsed.questions.length) return { questions: parsed.questions };
  } catch {}
  return null;
}

/** Read ~/.codecast/ask-input/<session>.json off the loop. */
export async function readAskInputSidecar(
  dir: string,
  sessionId: string,
  now: number,
): Promise<{ questions: any[] } | null> {
  try {
    const file = path.join(dir, `${sessionId}.json`);
    const [stat, raw] = await Promise.all([fs.promises.stat(file), fs.promises.readFile(file, "utf8")]);
    return parseAskInputSidecar(raw, stat.mtimeMs, now);
  } catch {
    return null;
  }
}

/**
 * How many options one digit can complete on the pending question, or null when
 * the prompt's shape means no digit finishes it.
 *
 * Digits only ANSWER a single-select with one question. On a multi-question form
 * a digit advances to the next question, and on a multiSelect it toggles a
 * checkbox — the agent stays blocked either way, so clearing the wait on one
 * would lie. Null also covers a missing or malformed sidecar: unknown shape
 * fails closed.
 */
export function singleSelectOptionCount(questions: unknown): number | null {
  if (!Array.isArray(questions) || questions.length !== 1) return null;
  const question = questions[0] as { multiSelect?: unknown; options?: unknown } | null | undefined;
  if (!question || question.multiSelect === true || !Array.isArray(question.options)) return null;
  return question.options.length;
}

/**
 * A turn that is producing, and so has something to interrupt.
 *
 * MID_TURN_AGENT_STATUSES also holds permission_blocked, where Escape declines
 * the prompt and the agent carries on — inferring a turn end there would retire
 * a session that is still working.
 */
export function isInterruptibleTurn(status: AgentStatus): boolean {
  return MID_TURN_AGENT_STATUSES.has(status) && status !== "permission_blocked";
}

/** The status-row fields an inference arms against and re-checks before it writes. */
export interface InferenceBaseline {
  status: AgentStatus;
  /** When the status row last moved. */
  statusSentAt: number;
  /** When the current turn started. */
  turnStartedAt: number;
  agentType: string | undefined;
}

export function sameBaseline(a: InferenceBaseline, b: InferenceBaseline): boolean {
  return (
    a.status === b.status &&
    a.statusSentAt === b.statusSentAt &&
    a.turnStartedAt === b.turnStartedAt &&
    a.agentType === b.agentType
  );
}

export type InferenceOutcome =
  /** The keystroke means nothing here. */
  | "ignored"
  /** Interrupt timer armed; the write happens when it fires. */
  | "armed"
  /** Interrupted turn end written. */
  | "interrupted"
  /** The timer fired but the row had moved — a real signal won. */
  | "stood-down"
  /** The AskUserQuestion wait was cleared. */
  | "answered";

export interface KeystrokeInferenceDeps {
  /** The session's status row, or null when nothing is known about it. */
  readBaseline: (sessionId: string) => InferenceBaseline | null;
  /** True while a PreToolUse AskUserQuestion hook holds the session waiting. */
  isAwaitingQuestion: (sessionId: string) => boolean;
  /** Options the pending question declares; null when its shape rules digits out. */
  readOptionCount: (sessionId: string) => Promise<number | null>;
  /** Record the interrupted turn end. */
  writeInterrupted: (sessionId: string, baseline: InferenceBaseline) => void;
  /** Clear the wait and restore the state that preceded it. */
  writeQuestionAnswered: (sessionId: string, baseline: InferenceBaseline) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  log?: (msg: string) => void;
}

export interface KeystrokeInference {
  observeInput(sessionId: string, intent: InputIntent): Promise<InferenceOutcome>;
  /** Fire an armed interrupt now (the timer's own body; exported for tests). */
  flushPending(sessionId: string): InferenceOutcome;
  /** Drop anything armed for a session (it died, or its turn was superseded). */
  cancel(sessionId: string): void;
}

export function createKeystrokeInference(deps: KeystrokeInferenceDeps): KeystrokeInference {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  const pending = new Map<string, { baseline: InferenceBaseline; timer: ReturnType<typeof setTimeout> }>();

  function cancel(sessionId: string): void {
    const entry = pending.get(sessionId);
    if (!entry) return;
    pending.delete(sessionId);
    clearTimer(entry.timer);
  }

  function fresh(baseline: InferenceBaseline): boolean {
    return now() - baseline.statusSentAt <= STATUS_TRUST_TTL_MS;
  }

  function flushPending(sessionId: string): InferenceOutcome {
    const entry = pending.get(sessionId);
    if (!entry) return "ignored";
    pending.delete(sessionId);
    clearTimer(entry.timer);
    const current = deps.readBaseline(sessionId);
    // A hook or a transcript fact that landed inside the settle window moved
    // the row. Inference fills a MISSING signal and must never overwrite one
    // that arrived, so any disagreement stands the write down.
    if (
      !current ||
      !sameBaseline(current, entry.baseline) ||
      !isInterruptibleTurn(current.status) ||
      !fresh(current) ||
      deps.isAwaitingQuestion(sessionId)
    ) {
      deps.log?.(`[INFER] ${sessionId.slice(0, 8)}: interrupt stood down; a real signal got there first`);
      return "stood-down";
    }
    deps.writeInterrupted(sessionId, entry.baseline);
    return "interrupted";
  }

  async function observeInput(sessionId: string, intent: InputIntent): Promise<InferenceOutcome> {
    const baseline = deps.readBaseline(sessionId);
    if (!baseline || !fresh(baseline)) {
      cancel(sessionId);
      return "ignored";
    }

    if (deps.isAwaitingQuestion(sessionId)) {
      // A question on screen owns these keys: Enter and a declared option digit
      // answer it, Escape dismisses it. None of them interrupts a turn, so the
      // interrupt timer never arms here.
      cancel(sessionId);
      if (intent.kind === "ctrl-c") return "ignored";
      if (intent.kind === "digit") {
        const count = await deps.readOptionCount(sessionId);
        // A digit past the declared options is Claude's trailing "Type
        // something" row, which opens an editor rather than submitting. The
        // session stays blocked, so clearing the wait would lie.
        if (count === null || intent.value > count) return "ignored";
      }
      // The sidecar read yielded the loop; re-check everything it could have missed.
      if (!deps.isAwaitingQuestion(sessionId)) return "ignored";
      const current = deps.readBaseline(sessionId);
      if (!current || !sameBaseline(current, baseline)) return "ignored";
      deps.writeQuestionAnswered(sessionId, baseline);
      return "answered";
    }

    if (intent.kind !== "ctrl-c" && intent.kind !== "escape") return "ignored";
    if (!isInterruptibleTurn(baseline.status)) {
      cancel(sessionId);
      return "ignored";
    }
    cancel(sessionId);
    const timer = setTimer(() => { flushPending(sessionId); }, INTERRUPT_SETTLE_MS);
    timer.unref?.();
    pending.set(sessionId, { baseline, timer });
    return "armed";
  }

  return { observeInput, flushPending, cancel };
}
