// What one problem's page holds (line-journeys.md LJ8.3), derived once and
// pure: the act band's state (every problem has exactly one), the one line
// that states it beside the stage track, the runs as Work rows, and a
// finding's own text and where it leads. The components only draw this.
import type { CauseHistory, HistoryAttempt } from "./causeHistory";
import type { InboxRow } from "./lineInbox";
import { askParts, waitsForFindings } from "./lineInbox";
import type { LineIssue, LineRunModel } from "./lineModel";
import type { LineNeed, NeedKind } from "./lineNeeds";
import { STAGE_DOING, STAGE_WORDS, firstFailedVisit, type StageOf } from "./stageTrack";
import { findingTitle } from "./loopSteps";
import { attemptVerdict, problemState, shownWatches } from "./timeline";
import { guessPhase, type LinePhaseKey } from "@codecast/shared/contracts/linePhases";

export const dayWords = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
export const dayTimeWords = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
/** A span in a person's units: "42m", "2h", "3d". */
export function spanShort(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (m < 60) return `${m}m`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h * 10) / 10}`.replace(/\.0$/, "") + "h";
  return `${Math.round(h / 24)}d`;
}

/** A stored note that was cut at its cap ends mid-word: read it to its last full sentence (LJ3 rule 8). */
export function wholeSentences(text: string | null | undefined, cap = 500): string {
  const raw = text ?? "";
  const t = raw.trim();
  // Measured before trimming: a cut that landed on a space leaves one character fewer once trimmed.
  if (raw.length < cap && !/…$/.test(t)) return t;
  if (/[.?!]["')\]]?$/.test(t)) return t;
  const cut = t.replace(/…$/, "");
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return end > 40 ? cut.slice(0, end + 1) : cut;
}

/** A problem's title as every page heads it (its page, its runs): no "Not met:" prefix, cut at a whole sentence. */
export const problemTitle = (title: string): string => wholeSentences(findingTitle({ title }), 200);

/** What a question asks for, beyond yes or no (LJ6.2): the parts it names in a list ("(duration, who sees it, whether it
 *  hides the cause from review)"), and whether it asks for any content at all ("what snoozing should do"). A question
 *  that asks for content cannot be answered by a bare yes: the answer is required, one field per named part. */
export function askShape(question: string): { required: boolean; parts: string[] } {
  const q = question.replace(/\s+/g, " ").trim();
  const list = [...q.matchAll(/\(([^()]+)\)/g)].map((m) => m[1].split(/\s*,\s*|\s*;\s*|,?\s+(?:and|or)\s+(?=[a-z]+\b)/i).map((x) => x.trim()).filter(Boolean)).find((xs) => xs.length >= 2 && xs.length <= 6 && xs.every((x) => x.split(" ").length <= 9 && !/^(so|e\.g|i\.e)\b/i.test(x)));
  const parts = (list ?? []).map((x) => x.replace(/^(?:and|or)\s+/i, "").replace(/[.?]$/, "")).map((x) => x.charAt(0).toUpperCase() + x.slice(1));
  // Asking "what"/"how"/"which" (outside a "whether" clause) asks for content.
  const content = /\b(?:what|how|which|who|when|where)\b/i.test(q.replace(/\([^()]*\)/g, "").replace(/\bwhether\b[^,.;]*/gi, ""));
  return { required: parts.length > 0 || content, parts };
}

// ── the act band ─────────────────────────────────────────────────────────────

export type BandTask = {
  status: string; readiness?: string | null; readiness_note?: string | null; goal_ref?: unknown; assignee?: string | null;
  assignee_info?: { name?: string | null } | null; closed_at?: number | null; updated_at?: number | null; project_id?: string | null;
};

/** What waits on a person about the problem (lineNeeds needOfCase), as far as the band reads it. */
export type BandNeed = Pick<LineNeed, "kind" | "since" | "fail">;

export type ProblemBand =
  /** Something waits on a person: the one reader (WaitingItem) shows it and holds its act. */
  | { kind: "need"; need: NeedKind; since: number | null; /** For a stopped run: the step it ended at. For a lapsed fix: when it was asked. */ step: string | null; askedAt: number | null }
  /** A fix decision open on the problem that is not in the viewer's own queue: read and answerable all the same. */
  | { kind: "decision"; ref: string; since: number | null; /** Asked of the viewer; null while who was asked is not read yet. */ mine: boolean | null }
  /** A question the problem holds on that the needs do not carry (a project outside the filter): the Ask block. */
  | { kind: "ask"; question: string; note: string; required: boolean }
  | { kind: "failed"; step: string; reason: string | null; output: string | null; after: number | null; node: string | null; runId: string | null; at: number | null }
  | { kind: "stalled"; stage: string; step: string; node: string | null; silentMs: number; last: string | null; runId: string | null }
  | { kind: "running"; stage: string; doing: string; step: string; ms: number; runId: string | null }
  | { kind: "merged"; mergedAt: number; link: string | null; sha: string | null; recorded: "known" | "none" | "unread"; coverage: string }
  | { kind: "production"; mergedAt: number | null; link: string | null; sha: string | null; liveAt: number; target: string | null; deployUrl: string | null; watchEnd: number | null; watch: "watching" | "quiet" | "reopened" | null; since: number; sinceOff: number }
  /** Approved and the run went on to ship, but no merge is recorded: the fix sits on its branch. `mergeOff`: the ship
   *  step said the line's merge step is off (null when it said nothing about it). `change`: what the fix changes. */
  | { kind: "approved"; at: number | null; ref: string | null; mergeOff: boolean | null; change: HistoryAttempt["diff"]; runId: string }
  | { kind: "morefindings"; has: number; needs: string | null }
  | { kind: "closed"; at: number | null; how: string | null; why: string | null }
  | { kind: "notstarted"; lineOn: boolean | null; reason: string | null; ready: number | null; blocked: number | null };

export type BandInput = {
  issue: LineIssue;
  /** The problem's history as the page reads it (off-topic comebacks taken out). */
  history: CauseHistory;
  /** Its newest run on the process drawn. */
  run: LineRunModel | null;
  need: BandNeed | null;
  /** An open fix decision on the problem (fixDecision openFixDecisionFor), whoever holds it. */
  decision: { ref: string; since: number | null; mine: boolean | null } | null;
  /** Its row among the failed and silent runs (lineInbox), when it has one. */
  row: Pick<InboxRow, "kind" | "at" | "detail" | "fail"> | null;
  task: BandTask | null;
  lineOn: boolean | null;
  ready?: number | null;
  blocked?: number | null;
  /** Findings after the newest fix that cite another expectation than the problem's. */
  offTopic?: number;
  /** What the newest run's ship (or merge) step printed, whole: why a fix approved to ship did not merge. */
  shipOutput?: string | null;
  stageOf?: StageOf;
  now: number;
};

const stageKey = (node: string | null | undefined, label: string | undefined, stageOf?: StageOf): LinePhaseKey => (node ? stageOf?.(node, label) ?? guessPhase(node, label) : "understand");

/** A step's own last words, when it said any: never an outcome word standing in for them. */
const visitSaid = (v: { decided: { words: string }; why: string | null } | null | undefined): string | null => {
  const t = (v?.why ?? v?.decided.words ?? "").trim();
  return t && !/^(failed|done|running|waiting|success|failure)$/i.test(t) ? t : null;
};

/** Whether a ship step said it did not merge because the line's merge step is off ("not merged: merge is off for this
 *  line ..."): true, false when it gave another reason, null when it said nothing about merging. */
export function mergeStepOff(text: string | null | undefined): boolean | null {
  const m = (text ?? "").match(/not merged:\s*([^\n]+)/i);
  return m ? /merge is off/i.test(m[1]) : null;
}

/** Why a waiting problem that asks a person nothing has not started, in the words LJ11 gives. */
function blockedReason(task: BandTask | null): string | null {
  if (!task) return null;
  if (task.assignee) return `Assigned to ${task.assignee_info?.name ?? "someone"}: it does not start by itself`;
  if (!task.goal_ref) return "Needs a goal before it can start";
  if (task.readiness && task.readiness !== "ready" && task.readiness !== "needs_context") return "Not grounded yet";
  return null;
}

/** The one state a problem's page is in. First match wins, in the order a person can act (LJ8.2's precedence). */
export function problemBand(i: BandInput): ProblemBand {
  const { issue, history: h, run, need, row, task, now } = i;
  const last = h.attempts[h.attempts.length - 1] ?? null;
  const state = problemState(h, issue.status);
  const terminal = issue.status === "done" || issue.status === "dropped";

  if (need) {
    const stopped = need.kind === "stopped" ? run?.visits.find((x) => x.node === need.fail?.step)?.label ?? need.fail?.step ?? null : null;
    return { kind: "need", need: need.kind, since: need.since, step: stopped, askedAt: need.kind === "lapsed" ? last?.end ?? last?.start ?? need.since : null };
  }
  if (i.decision) return { kind: "decision", ref: i.decision.ref, since: i.decision.since, mine: i.decision.mine };
  if (issue.ask && !waitsForFindings(issue.ask)) {
    const note = wholeSentences(issue.ask);
    const q = askParts(note).question;
    return { kind: "ask", question: q, note, required: issue.findings > 1 || /\?$/.test(q) || / or /.test(q) };
  }

  if (last?.live || run?.live) {
    const v = run?.visits[run.visits.length - 1] ?? null;
    const key = stageKey(v?.node ?? run?.at_node, v?.label, i.stageOf);
    if (row?.kind === "stalled") return { kind: "stalled", stage: STAGE_WORDS[key], step: v?.label ?? row.detail ?? STAGE_WORDS[key], node: v?.node ?? null, silentMs: Math.max(0, now - (row.at ?? run?.updatedAt ?? now)), last: visitSaid(v), runId: run?.id ?? null };
    return { kind: "running", stage: STAGE_WORDS[key], doing: STAGE_DOING[key], step: v?.label ?? STAGE_WORDS[key], ms: Math.max(0, now - (last?.start ?? run?.at ?? now)), runId: run?.id ?? null };
  }

  if (!terminal && (row?.kind === "failed" || (last && !last.ended && last.outcome.tone === "failed"))) {
    const v = firstFailedVisit(run);
    return {
      kind: "failed", step: v?.label ?? row?.fail?.step ?? "a step", reason: row?.fail?.label ?? row?.detail ?? null, output: visitSaid(v),
      after: v?.durationMs ?? null, node: v?.node ?? null, runId: run?.id ?? last?.runId ?? null, at: row?.at ?? last?.end ?? null,
    };
  }

  // A fix that merged: in production when a deploy carried it, else merged and waiting on a deploy codecast does not make.
  // The merge is read off the recorded ship, else off the run itself (a run whose merge landed with no ship step recorded).
  const ship = [...h.ships].reverse().find((s) => s.merge || s.deploys.length) ?? null;
  const merged = [...h.attempts].reverse().find((a) => a.merge && !a.live) ?? null;
  const merge = ship?.merge ?? merged?.merge ?? null;
  const reopenedSince = h.regressed || h.cameBack;
  if ((ship || merge) && issue.status !== "dropped") {
    if (ship?.deploys.length) {
      const d = ship.deploys[0];
      const watch = shownWatches(h).find((w) => w.runId === ship.runId) ?? null;
      const back = h.regressions.find((r) => r.afterRunId === ship.runId);
      return { kind: "production", mergedAt: merge?.at ?? null, link: merge?.prUrl ?? null, sha: merge?.sha ?? null, liveAt: d.at, target: d.target, deployUrl: d.url, watchEnd: watch?.end ?? null, watch: watch && watch.state !== "unknown" ? watch.state : null, since: back?.count ?? 0, sinceOff: i.offTopic ?? 0 };
    }
    if (merge && !reopenedSince) return { kind: "merged", mergedAt: merge.at, link: merge.prUrl, sha: merge.sha, recorded: h.coverage.state, coverage: h.coverage.words };
  }
  // The run reached its ship step with an answer, and nothing merged: say so, with the step's own reason.
  if (last && last.ended === "shipped" && !merge && !ship && !last.unapproved && issue.status !== "dropped" && !h.regressed) {
    return { kind: "approved", at: last.card?.answeredAt ?? last.end, ref: last.card?.ref ?? null, mergeOff: mergeStepOff(i.shipOutput), change: last.diff, runId: last.runId };
  }

  if (issue.ask && waitsForFindings(issue.ask)) return { kind: "morefindings", has: issue.findings, needs: wholeSentences(issue.ask) || null };
  if (state === "closed" || state === "folded" || state === "held" || terminal) {
    const close = h.closes[h.closes.length - 1] ?? null;
    const how = close?.kind === "dissolved" ? "Turned out not to be a problem" : close?.kind === "dropped" || issue.status === "dropped" ? "Dropped" : close?.kind === "shipped" ? "Fixed" : null;
    return { kind: "closed", at: task?.closed_at ?? close?.at ?? null, how, why: issue.dissolvedWhy ?? close?.fold?.words ?? null };
  }
  return { kind: "notstarted", lineOn: i.lineOn, reason: blockedReason(task), ready: i.ready ?? null, blocked: i.blocked ?? null };
}

/** The one statement of the problem's state, beside the stage track (LJ6.4). Nothing else on the page repeats it. */
export function bandLine(b: ProblemBand): { text: string; tone: "you" | "bad" | "warn" | "live" | "ok" | "none" } {
  switch (b.kind) {
    case "need":
      if (b.need === "decision") return { text: `Waiting on you${b.since ? ` since ${dayWords(b.since)}` : ""}`, tone: "you" };
      if (b.need === "question") return { text: "Needs a fact from you", tone: "you" };
      if (b.need === "confirm") return { text: "New: is this real?", tone: "you" };
      if (b.need === "lapsed") return { text: `Asked${b.askedAt ? ` ${dayWords(b.askedAt)}` : ""}, no answer`, tone: "warn" };
      if (b.need === "stopped") return { text: `Stopped${b.step ? ` at ${b.step}` : ""}: needs your yes`, tone: "warn" };
      return { text: "Needs a new ask", tone: "warn" };
    // The decision's holder is not on its row yet (LJ9 item 12).
    case "decision":
      if (b.mine) return { text: `Waiting on you${b.since ? ` since ${dayWords(b.since)}` : ""}`, tone: "you" };
      return b.mine === false ? { text: "Waiting on someone else", tone: "none" } : { text: "Waiting on an answer", tone: "none" };
    case "ask": return { text: b.required ? "Needs a fact from you" : "New: is this real?", tone: "you" };
    case "failed": return { text: `Failed at ${b.step}${b.after ? ` after ${spanShort(b.after)}` : ""}`, tone: "bad" };
    case "stalled": return { text: `No progress for ${spanShort(b.silentMs)} at ${b.step}`, tone: "bad" };
    case "running": return { text: `${b.doing}, ${spanShort(b.ms)} in`, tone: "live" };
    case "merged": return { text: b.recorded === "known" ? `Merged ${dayWords(b.mergedAt)}, not in production` : `Merged ${dayWords(b.mergedAt)}`, tone: b.recorded === "known" ? "warn" : "ok" };
    case "production": {
      const tail = b.since > 0 ? `, ${b.since} since` : b.watch === "watching" && b.watchEnd ? `, watching until ${dayWords(b.watchEnd)}` : ", quiet since";
      return { text: `In production ${dayWords(b.liveAt)}${tail}`, tone: b.since > 0 ? "bad" : "ok" };
    }
    case "approved": return { text: `Approved${b.at ? ` ${dayWords(b.at)}` : ""}, not merged`, tone: "warn" };
    case "morefindings": return { text: `Waiting for more findings (has ${b.has})`, tone: "none" };
    case "closed": return { text: `Closed${b.at ? ` ${dayWords(b.at)}` : ""}`, tone: "none" };
    case "notstarted": return { text: b.lineOn === false ? "Not started: line off" : b.reason ? "Not started" : b.lineOn ? "Queued" : "Not started", tone: "none" };
  }
}

// ── work: one row per run ────────────────────────────────────────────────────

export type WorkRow = {
  runId: string; n: number; start: number; durationMs: number | null; live: boolean;
  /** What the run proposed, in its own headline; else what it found. */
  headline: string;
  outcome: string; tone: "ok" | "bad" | "warn" | "live" | "you" | "none";
  found: string | null;
  change: { files: number; added: number; removed: number; pr: string | null; branch: string | null; sha: string | null } | null;
  /** The run's own red and green steps: it failed before the change, it passes after. */
  proof: { before: boolean; after: boolean } | null;
  /** Who answered what, and when; null when nobody was asked. */
  answer: { ref: string | null; words: string; at: number | null } | null;
  /** The run is in the process drawn, so its page opens. */
  opens: boolean;
};

const OUTCOME: Record<string, string> = { "not shipped": "Asked you, no answer", dissolved: "Turned out not to be a problem", running: "Running", "waiting on you": "Waiting on you", stuck: "No progress" };
/** Verdicts that claim a fix went out: their words come from the run's own merge and deploy facts, never the verdict alone. */
const FIX_OUT = new Set(["deployed", "merged", "merged, not deployed", "shipped", "shipped, not deployed"]);

/** What a run's fix came to, read off the facts the band reads (its merge record, its ship's deploys), so a run row and
 *  the band never disagree: a fix with no merge record is "Approved <day>, not merged" whatever the verdict says. */
export function fixOutcome(a: HistoryAttempt, h: Pick<CauseHistory, "ships" | "coverage">, verdict = attemptVerdict(a, h).word): { words: string; tone: "ok" | "warn" } {
  const ship = h.ships.find((s) => s.runId === a.runId);
  const merge = a.merge ?? ship?.merge ?? null;
  if (ship?.deploys.length) return { words: "In production", tone: a.unapproved ? "warn" : "ok" };
  if (!merge) { const at = a.card?.answeredAt ?? a.end; return { words: `Approved${at ? ` ${dayWords(at)}` : ""}, not merged`, tone: "warn" }; }
  return /not deployed/.test(verdict) ? { words: "Merged, not in production", tone: "warn" } : { words: "Merged", tone: a.unapproved ? "warn" : "ok" };
}

function runProof(run: LineRunModel | null): WorkRow["proof"] {
  if (!run) return null;
  const red = run.visits.find((v) => v.node === "red");
  const green = [...run.visits].reverse().find((v) => v.node === "green");
  const before = !!red && red.status === "done" && red.decided.result?.red !== false;
  const after = !!green && green.status === "done";
  return before || after ? { before, after } : null;
}

export function workRows(h: CauseHistory, runs: ReadonlyArray<LineRunModel>): WorkRow[] {
  const byId = new Map(runs.map((r) => [r.id, r]));
  return [...h.attempts].reverse().map((a) => {
    const run = byId.get(a.runId) ?? null;
    const v = attemptVerdict(a, h);
    const failed = firstFailedVisit(run);
    const lastStep = run?.visits[run.visits.length - 1]?.label ?? null;
    const card = a.card;
    const fixOut = FIX_OUT.has(v.word) ? fixOutcome(a, h, v.word) : null;
    let outcome = fixOut?.words ?? OUTCOME[v.word] ?? v.word.charAt(0).toUpperCase() + v.word.slice(1);
    // A run paused at a person's step is not running: it waits on an answer, and the band above holds it.
    const paused = a.live && !!run && (run.status === "paused" || run.visits[run.visits.length - 1]?.status === "waiting");
    if (paused) outcome = "Waiting on an answer";
    else if (v.word === "failed") outcome = `Failed at ${failed?.label ?? lastStep ?? "a step"}`;
    else if (v.word === "dropped") outcome = card?.answer ? "Dropped by you" : "Dropped";
    else if (/^stopped/.test(v.word)) outcome = `Stopped at ${lastStep ?? "a step"}`;
    else if (a.ended === "parked") outcome = "Needs a fact from you";
    const tone: WorkRow["tone"] = paused || v.tone === "person" ? "you" : fixOut ? fixOut.tone : v.tone === "closed" ? "none" : v.tone;
    const ship = h.ships.find((s) => s.runId === a.runId);
    const merge = a.merge ?? ship?.merge ?? null;
    return {
      runId: a.runId, n: a.n, start: a.start, durationMs: a.end != null ? a.end - a.start : null, live: a.live,
      headline: card?.headline ?? a.proposed ?? a.found ?? a.outcome.text, outcome, tone,
      found: a.found,
      change: a.diff || merge ? { files: a.diff?.files ?? 0, added: a.diff?.added ?? 0, removed: a.diff?.removed ?? 0, pr: a.diff?.pr ?? merge?.prUrl ?? null, branch: merge?.branch ?? null, sha: merge?.sha ?? null } : null,
      proof: runProof(run),
      answer: card ? { ref: card.ref, words: card.answer ?? (a.unapproved ? "No answer" : card.status === "pending" || card.status === "waiting" ? "Waiting on an answer" : card.status.charAt(0).toUpperCase() + card.status.slice(1)), at: card.answeredAt } : null,
      opens: !!run,
    };
  });
}

// ── findings ─────────────────────────────────────────────────────────────────

export type FindingLike = { title: string; detail_md?: string | null; evidence_url?: string | null; source: string; subject?: string | null };

/** Lines a finder writes for its own bookkeeping, which tell a reader nothing about what happened. */
const BOOKKEEPING = [/^breaks expectation\b/i, /^\d+ findings? in this\b/i, /^\d+ escalations? and difficulty notes? under this fingerprint\b/i];

export type FindingBlock = { kind: "text" | "quote" | "code"; text: string };

/** A finding's own words in full, as blocks: paragraphs, what it quotes, and raw output. The restated title, the
 *  severity tag and the finder's bookkeeping lines are left out. */
export function findingBlocks(s: FindingLike): FindingBlock[] {
  const title = s.title.replace(/^not met:\s*/i, "").toLowerCase().replace(/[.\s]+$/, "");
  const out: FindingBlock[] = [];
  const parts = (s.detail_md ?? "").split(/(```[\s\S]*?(?:```|$))/);
  for (const part of parts) {
    if (part.startsWith("```")) {
      const code = part.replace(/^```[^\n]*\n?/, "").replace(/```\s*$/, "").trim();
      if (code) out.push({ kind: "code", text: code });
      continue;
    }
    for (const raw of part.split(/\n\s*\n/)) {
      const para = raw.trim();
      if (!para) continue;
      if (/^>/.test(para)) {
        const q = para.split("\n").map((l) => l.replace(/^\s*>\s?/, "")).join("\n").trim();
        if (q) out.push({ kind: "quote", text: q });
        continue;
      }
      let text = para.replace(/\*\*|__/g, "").replace(/`([^`]+)`/g, "$1").replace(/\s*\(severity \d+\/10[^)]*\)/i, "").trim();
      // A paragraph that only restates the title says nothing new.
      if (text.toLowerCase().replace(/[.\s]+$/, "") === title) continue;
      if (text.toLowerCase().startsWith(title) && text.length - title.length < 4) continue;
      text = text.split("\n").filter((l) => !BOOKKEEPING.some((re) => re.test(l.trim()))).join("\n").trim();
      if (text) out.push({ kind: "text", text });
    }
  }
  return out;
}

/** A finding an event source filed for an error group (ingest promotionSignal): which group, what happened to it, and
 *  the counts its text carries. Its body is the group itself (stack, samples), read in place, never the filer's text. */
export type EventFinding = { group: string; transition: string; count: number | null; release: string | null; culprit: string | null };

export function eventFinding(s: Pick<FindingLike, "detail_md" | "subject">): EventFinding | null {
  const d = s.detail_md ?? "";
  const head = d.match(/^([a-z ]+?) in \S+, group (eg-\d+) \(/i);
  const group = (s.subject && /^eg-\d+$/i.test(s.subject) ? s.subject : null) ?? head?.[2] ?? null;
  if (!group || !head) return null;
  const seen = d.match(/Seen (\d+) times?(?:, last in ([^\n]+?))?\.?$/m);
  const culprit = d.match(/^Culprit: (.+)$/m)?.[1]?.trim() ?? null;
  const word = head[1].trim();
  return { group, transition: word.charAt(0).toUpperCase() + word.slice(1), count: seen ? Number(seen[1]) : null, release: seen?.[2]?.trim() ?? null, culprit };
}

/** An event finding's row: what happened, where, how often. "Regressed in e2e@1.3.0 · 7 times". */
export function eventFindingWords(e: EventFinding): string {
  return [`${e.transition}${e.release ? ` in ${e.release}` : ""}`, e.count != null ? `${e.count} ${e.count === 1 ? "time" : "times"}` : null].filter(Boolean).join(" · ");
}

/** Where a finding's evidence link goes, named for its target (LJ6.3). */
export function evidenceLinkWords(url: string): string {
  let u: URL | null = null;
  try { u = new URL(url); } catch { return "Open the evidence"; }
  if (/slack\.com$/.test(u.hostname)) return "Open in Slack";
  if (/agent-runs/.test(u.pathname)) return "Open the agent run in Union";
  if (/agent-watch/.test(u.pathname)) return u.searchParams.get("finding") ? "Open the finding in Union" : "Open the cluster in Union";
  if (/unionmatching\.com$/.test(u.hostname)) return "Open in Union";
  if (/github\.com$/.test(u.hostname)) return "Open on GitHub";
  return `Open on ${u.hostname.replace(/^www\./, "")}`;
}
