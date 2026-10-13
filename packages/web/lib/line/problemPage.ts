// What one problem's page holds (line-journeys.md LJ8.3), derived once and
// pure: the act band's state (every problem has exactly one), the one line
// that states it beside the stage track, the runs as Work rows, and a
// finding's own text and where it leads. The components only draw this.
import type { CauseHistory, HistoryAttempt } from "./causeHistory";
import type { InboxRow } from "./lineInbox";
import { askParts, waitsForFindings } from "./lineInbox";
import type { LineIssue, LineRunModel } from "./lineModel";
import { UNAPPROVED_WORDS } from "./runReport";
import { STAGE_DOING, STAGE_WORDS, firstFailedVisit, type StageOf } from "./stageTrack";
import { attemptVerdict, problemState, shownWatches } from "./timeline";
import { guessPhase, type LinePhaseKey } from "@codecast/shared/contracts/linePhases";

const DAY_MS = 86_400_000;
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

/** The median length of the finished runs given, when there are three or more: under that it is an anecdote (LJ6.6). */
export function medianRunMs(runs: ReadonlyArray<Pick<LineRunModel, "durationMs" | "live">>): number | null {
  const ds = runs.filter((r) => !r.live && typeof r.durationMs === "number" && r.durationMs > 0).map((r) => r.durationMs!).sort((a, b) => a - b);
  if (ds.length < 3) return null;
  const mid = ds.length >> 1;
  return ds.length % 2 ? ds[mid] : (ds[mid - 1] + ds[mid]) / 2;
}

/** A stored note that was cut at its cap ends mid-word: read it to its last full sentence (LJ3 rule 8). */
export function wholeSentences(text: string | null | undefined, cap = 500): string {
  const t = (text ?? "").trim();
  if (t.length < cap && !/…$/.test(t)) return t;
  if (/[.?!]["')\]]?$/.test(t)) return t;
  const cut = t.replace(/…$/, "");
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return end > 40 ? cut.slice(0, end + 1) : cut;
}

// ── the act band ─────────────────────────────────────────────────────────────

/** The fix a problem's run asked about: its decision (sd-N), or a trial card no session posted as one (tc-N). */
export type ProblemLead = { kind: "decision" | "card"; ref: string; trial: boolean; /** It can take an answer now. */ answerable: boolean; since?: number | null };

export type BandTask = {
  status: string; readiness?: string | null; readiness_note?: string | null; goal_ref?: unknown; assignee?: string | null;
  assignee_info?: { name?: string | null } | null; closed_at?: number | null; updated_at?: number | null; project_id?: string | null;
};

export type ProblemBand =
  | { kind: "decision"; ref: string; trial: boolean; since: number | null }
  | { kind: "ask"; question: string; context: string | null; /** A written answer is required (it asks what a person knows), else a note is optional (is this real?). */ required: boolean; since: number | null }
  | { kind: "reask"; ref: string; card: boolean; since: number | null }
  | { kind: "lapsed"; ref: string | null; askedAt: number | null; runId: string; n: number; diff: HistoryAttempt["diff"]; branch: string | null }
  | { kind: "stopped"; step: string; message: string | null; at: number | null; runId: string | null }
  | { kind: "failed"; step: string; reason: string | null; output: string | null; after: number | null; node: string | null; runId: string | null; at: number | null }
  | { kind: "stalled"; stage: string; step: string; node: string | null; silentMs: number; last: string | null; runId: string | null }
  | { kind: "running"; stage: string; step: string; ms: number; runId: string | null }
  | { kind: "merged"; mergedAt: number; link: string | null; sha: string | null; recorded: "known" | "none" | "unread"; coverage: string }
  | { kind: "production"; mergedAt: number | null; link: string | null; liveAt: number; target: string | null; deployUrl: string | null; watchEnd: number | null; watch: "watching" | "quiet" | "reopened" | null; since: number; sinceOff: number }
  | { kind: "morefindings"; has: number; needs: string | null }
  | { kind: "closed"; at: number | null; how: string | null; why: string | null }
  | { kind: "notstarted"; lineOn: boolean | null; reason: string | null; ready: number | null; blocked: number | null };

export type BandInput = {
  issue: LineIssue;
  /** The problem's history as the page reads it (off-topic comebacks taken out). */
  history: CauseHistory;
  /** Its newest run on the process drawn. */
  run: LineRunModel | null;
  lead: ProblemLead | null;
  /** Its row in what waits or failed (lineInbox), when it has one. */
  row: Pick<InboxRow, "kind" | "at" | "detail" | "fail"> | null;
  task: BandTask | null;
  lineOn: boolean | null;
  ready?: number | null;
  blocked?: number | null;
  /** Findings after the newest fix that cite another expectation than the problem's. */
  offTopic?: number;
  stageOf?: StageOf;
  now: number;
};

const stageKey = (node: string | null | undefined, label: string | undefined, stageOf?: StageOf): LinePhaseKey => (node ? stageOf?.(node, label) ?? guessPhase(node, label) : "understand");

/** A step's own last words, when it said any: never an outcome word standing in for them. */
const visitSaid = (v: { decided: { words: string }; why: string | null } | null | undefined): string | null => {
  const t = (v?.why ?? v?.decided.words ?? "").trim();
  return t && !/^(failed|done|running|waiting|success|failure)$/i.test(t) ? t : null;
};

/** Why a waiting problem that nothing blocks on a person has not started, in the words LJ11 gives. */
function blockedReason(task: BandTask | null): string | null {
  if (!task) return null;
  if (task.assignee) return `Assigned to ${task.assignee_info?.name ?? "someone"}: it does not start by itself`;
  if (!task.goal_ref) return "Needs a goal before it can start";
  if (task.readiness && task.readiness !== "ready") return task.readiness === "needs_context" ? null : "Not grounded yet";
  return null;
}

/** The one state a problem's page is in. First match wins, in the order a person can act (LJ8.2's precedence). */
export function problemBand(i: BandInput): ProblemBand {
  const { issue, history: h, run, lead, row, task, now } = i;
  const last = h.attempts[h.attempts.length - 1] ?? null;
  const state = problemState(h, issue.status);

  if (lead?.answerable && lead.kind === "decision") return { kind: "decision", ref: lead.ref, trial: lead.trial, since: lead.since ?? null };
  if (issue.ask && !waitsForFindings(issue.ask)) {
    const parts = askParts(wholeSentences(issue.ask));
    const required = row?.kind ? row.kind === "question" : issue.findings > 1 || /\?$/.test(parts.question) || / or /.test(parts.question);
    return { kind: "ask", question: parts.question, context: parts.context, required, since: row?.at ?? task?.updated_at ?? null };
  }
  if (lead) return { kind: "reask", ref: lead.ref, card: lead.kind === "card", since: lead.since ?? null };

  const terminal = issue.status === "done" || issue.status === "dropped";
  const lapsed = row?.kind === "unapproved" || (issue.where.text === UNAPPROVED_WORDS && !h.regressed && !terminal);
  if (lapsed && last) return { kind: "lapsed", ref: last.card?.ref ?? null, askedAt: last.card?.answeredAt ?? last.end ?? last.start, runId: last.runId, n: last.n, diff: last.diff, branch: last.merge?.branch ?? null };

  // A run whose step finished and had nowhere to go waits on a person's yes: a need, never a failure.
  if (row?.kind === "failed" && row.fail?.key.startsWith("deadend:")) {
    const v = run?.visits.find((x) => x.node === row.fail!.step) ?? run?.visits[run.visits.length - 1] ?? null;
    return { kind: "stopped", step: v?.label ?? row.fail.step ?? "its last step", message: visitSaid(v) ?? row.fail.label ?? null, at: row.at, runId: run?.id ?? null };
  }

  if (last?.live || run?.live) {
    const v = run?.visits[run.visits.length - 1] ?? null;
    const stage = STAGE_WORDS[stageKey(v?.node ?? run?.at_node, v?.label, i.stageOf)];
    if (row?.kind === "stalled") return { kind: "stalled", stage, step: v?.label ?? row.detail ?? stage, node: v?.node ?? null, silentMs: Math.max(0, now - (row.at ?? run?.updatedAt ?? now)), last: visitSaid(v), runId: run?.id ?? null };
    return { kind: "running", stage: STAGE_DOING[stageKey(v?.node ?? run?.at_node, v?.label, i.stageOf)], step: v?.label ?? stage, ms: Math.max(0, now - (last?.start ?? run?.at ?? now)), runId: run?.id ?? null };
  }

  if (!terminal && (row?.kind === "failed" || (last && !last.ended && last.outcome.tone === "failed"))) {
    const v = firstFailedVisit(run);
    return {
      kind: "failed", step: v?.label ?? row?.fail?.step ?? "a step", reason: row?.fail?.label ?? row?.detail ?? null, output: visitSaid(v),
      after: v?.durationMs ?? null, node: v?.node ?? null, runId: run?.id ?? last?.runId ?? null, at: row?.at ?? last?.end ?? null,
    };
  }

  // A fix that merged: in production when a deploy carried it, else merged and waiting on a deploy codecast does not make.
  const ship = [...h.ships].reverse().find((s) => s.merge || s.deploys.length) ?? null;
  if (ship && (state === "watching" || state === "held" || state === "unapproved" || state === "regressed")) {
    const merge = ship.merge;
    if (ship.deploys.length) {
      const d = ship.deploys[0];
      const watch = shownWatches(h).find((w) => w.runId === ship.runId) ?? null;
      const back = h.regressions.find((r) => r.afterRunId === ship.runId);
      return { kind: "production", mergedAt: merge?.at ?? null, link: merge?.prUrl ?? null, liveAt: d.at, target: d.target, deployUrl: d.url, watchEnd: watch?.end ?? null, watch: watch && watch.state !== "unknown" ? (watch.state as "watching" | "quiet" | "reopened") : null, since: back?.count ?? 0, sinceOff: i.offTopic ?? 0 };
    }
    if (merge) return { kind: "merged", mergedAt: merge.at, link: merge.prUrl, sha: merge.sha, recorded: h.coverage.state, coverage: h.coverage.words };
  }

  if (issue.ask && waitsForFindings(issue.ask)) return { kind: "morefindings", has: issue.findings, needs: wholeSentences(issue.ask) || null };
  if (state === "closed" || state === "folded" || state === "held" || terminal) {
    const close = h.closes[h.closes.length - 1] ?? null;
    const how = close?.kind === "dissolved" ? "Turned out not to be a problem" : close?.kind === "dropped" || issue.status === "dropped" ? "Dropped" : close?.fold ? close.fold.words : null;
    return { kind: "closed", at: task?.closed_at ?? close?.at ?? null, how, why: issue.dissolvedWhy ?? close?.fold?.words ?? null };
  }
  return { kind: "notstarted", lineOn: i.lineOn, reason: blockedReason(task), ready: i.ready ?? null, blocked: i.blocked ?? null };
}

/** The one statement of the problem's state, beside the stage track (LJ6.4). Nothing else on the page repeats it. */
export function bandLine(b: ProblemBand, o: { holder?: string | null; mine?: boolean } = {}): { text: string; tone: "you" | "bad" | "warn" | "live" | "ok" | "none" } {
  switch (b.kind) {
    case "decision": return o.mine === false ? { text: `Waiting on ${o.holder ?? "someone else"}`, tone: "none" } : { text: `Waiting on you${b.since ? ` since ${dayWords(b.since)}` : ""}`, tone: "you" };
    case "ask": return { text: b.required ? "Needs a fact from you" : "New: is this real?", tone: "you" };
    case "reask": return { text: "Needs a new ask", tone: "warn" };
    case "lapsed": return { text: `Asked${b.askedAt ? ` ${dayWords(b.askedAt)}` : ""}, no answer`, tone: "warn" };
    case "stopped": return { text: `Stopped at ${b.step}: needs your yes`, tone: "warn" };
    case "failed": return { text: `Failed at ${b.step}${b.after ? ` after ${spanShort(b.after)}` : ""}`, tone: "bad" };
    case "stalled": return { text: `No progress for ${spanShort(b.silentMs)} at ${b.step}`, tone: "bad" };
    case "running": return { text: `${b.stage}, ${spanShort(b.ms)} in`, tone: "live" };
    case "merged": return { text: b.recorded === "known" ? `Merged ${dayWords(b.mergedAt)}, not in production` : `Merged ${dayWords(b.mergedAt)}`, tone: b.recorded === "known" ? "warn" : "ok" };
    case "production": {
      const tail = b.since > 0 ? `, ${b.since} since` : b.watch === "watching" && b.watchEnd ? `, watching until ${dayWords(b.watchEnd)}` : ", quiet since";
      return { text: `In production ${dayWords(b.liveAt)}${tail}`, tone: b.since > 0 ? "bad" : "ok" };
    }
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

const OUTCOME: Record<string, string> = { deployed: "In production", merged: "Merged", "merged, not deployed": "Merged, not in production", "shipped, not deployed": "Merged, not in production", shipped: "Merged", "not shipped": "Asked you, no answer", dissolved: "Turned out not to be a problem", running: "Running", "waiting on you": "Waiting on you", stuck: "No progress" };

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
    let outcome = OUTCOME[v.word] ?? v.word.charAt(0).toUpperCase() + v.word.slice(1);
    if (v.word === "failed") outcome = `Failed at ${failed?.label ?? lastStep ?? "a step"}`;
    else if (v.word === "dropped") outcome = card?.answer ? "Dropped by you" : "Dropped";
    else if (/^stopped/.test(v.word)) outcome = `Stopped at ${lastStep ?? "a step"}`;
    else if (a.ended === "parked") outcome = "Needs a fact from you";
    const tone: WorkRow["tone"] = v.tone === "person" ? "you" : v.tone === "closed" ? "none" : v.tone;
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

/** Findings per bucket over the problem's life, for the 64px strip: about `target` buckets from the first finding to now. */
export function findingStrip(times: ReadonlyArray<number>, now: number, target = 48): { from: number; step: number; counts: number[] } | null {
  if (!times.length) return null;
  const first = Math.min(...times);
  const span = Math.max(now - first, DAY_MS);
  const step = Math.max(3_600_000, Math.ceil(span / target / 3_600_000) * 3_600_000);
  const from = Math.floor(first / step) * step;
  const n = Math.max(1, Math.ceil((now - from) / step));
  const counts = new Array<number>(n).fill(0);
  for (const t of times) { const k = Math.min(n - 1, Math.max(0, Math.floor((t - from) / step))); counts[k]++; }
  return { from, step, counts };
}
