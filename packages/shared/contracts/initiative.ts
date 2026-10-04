// An initiative (docs/architecture/initiatives-projects-role-page.md I1): a
// goal the company is trying to reach, carried by an intentional set of
// projects, with one owner who drives it. ONE definition of its values and its
// synced row, read by the server validators (convex/initiatives.ts), the CLI
// (`cast initiative`) and the web store, so no two surfaces name a different
// status or health.
//
// The row is raw. Everything a page shows beside it is derived at render from
// the store: progress (tasks done over tasks in its projects), each project's
// lead (contracts/orgLead.ts), the owner's face and name, and sub initiatives
// (rows whose `parent_initiative_id` names this one).
//
// The intent record (I5) is the row's second half: why it matters, what done
// looks like, milestones, every reported number over time, open questions,
// decisions taken, and the sources that say who stated the goal and where.

export const INITIATIVE_STATUSES = ["proposed", "planned", "active", "completed", "cancelled"] as const;
export type InitiativeStatus = (typeof INITIATIVE_STATUSES)[number];

/** What an update may say. `none` is the row's value before any update exists. */
export const INITIATIVE_UPDATE_HEALTHS = ["on_track", "at_risk", "off_track"] as const;
export type InitiativeUpdateHealth = (typeof INITIATIVE_UPDATE_HEALTHS)[number];
export type InitiativeHealth = "none" | InitiativeUpdateHealth;
export const INITIATIVE_HEALTHS = ["none", ...INITIATIVE_UPDATE_HEALTHS] as const;

export const INITIATIVE_STATUS_LABEL: Record<InitiativeStatus, string> = {
  proposed: "Proposed",
  planned: "Planned",
  active: "Active",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const INITIATIVE_HEALTH_LABEL: Record<InitiativeHealth, string> = {
  none: "No update",
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
};

/** A person or a role: roles are colleagues (org-roles-run-work.md R5). */
export type InitiativeOwner =
  | { kind: "user"; user_id: string }
  | { kind: "role"; role_id: string };

/** Who wrote an update: a person, or a role through its standing session. */
export type InitiativeUpdateAuthor =
  | { kind: "user"; user_id: string }
  | { kind: "role"; role_id: string; conversation_id?: string };

export type InitiativePriority = "p0" | "p1" | "p2" | "p3";

/**
 * How a goal is measured: one or two numbers with a target each, read against
 * the target wherever the goal is read (the page, the health panel, the role
 * card and the review), so "on track" means against the target and not only
 * what the owner said. The value is reported the way a template's scoreboard
 * is (`cast initiative report in-N key=value --source`, the same
 * `recordScores` path as `cast org template report`), and lives in
 * `scoreboard` under the metric's key with its source and date.
 */
export type InitiativeMetric = {
  /** A slug (metricKeyOf(name)); the scoreboard's key. */
  key: string;
  name: string;
  /** The number to reach, as written: "1000", "$50k", "< 5%", "at least 40". */
  target: string;
};
export const INITIATIVE_METRICS_MAX = 2;
/** A reported value: the template scoreboard's own shape (orgTemplateState.ScoreState). */
export type InitiativeScore = { value: string; observed_at: number; source: string };

export const metricKeyOf = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);

/**
 * Read a number out of a target or a value as people write them: "1,000",
 * "$50k", "2.5M", "38%", "at least 40", "< 5%". Null when there is none.
 */
export function metricNumber(text: string | null | undefined): number | null {
  const m = (text ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?\s*([kKmM])?(?![a-zA-Z])/);
  if (!m) return null;
  const n = Number(m[0].replace(/[kKmM\s]/g, ""));
  if (!Number.isFinite(n)) return null;
  const unit = m[1]?.toLowerCase();
  return unit === "k" ? n * 1_000 : unit === "m" ? n * 1_000_000 : n;
}
/** The way a target is to be met: reach it (the default), or stay under it ("< 5%", "under 3", "at most 10"). */
export const metricDirection = (target: string): "at_least" | "at_most" => /^\s*(<=?|under|below|at most|no more than|max(?:imum)?)\b/i.test(target) || /\bor (?:less|fewer|under)\b/i.test(target) ? "at_most" : "at_least";

export type MetricStanding = "met" | "behind" | "unknown";
export type MetricReading = InitiativeMetric & {
  /** The reported value as written, or null before one was reported. */
  value: string | null;
  observed_at: number | null;
  source: string | null;
  /** Against the target: met, behind, or unknown when either side is not a number. */
  standing: MetricStanding;
  /** How far toward a reach target, 0 to 1; null when it cannot be read. */
  progress: number | null;
};

/** One metric read against its target. */
export function metricReading(metric: InitiativeMetric, score?: InitiativeScore | null): MetricReading {
  const value = score?.value ?? null;
  const n = metricNumber(value);
  const t = metricNumber(metric.target);
  const direction = metricDirection(metric.target);
  const standing: MetricStanding = n === null || t === null ? "unknown" : direction === "at_most" ? (n <= t ? "met" : "behind") : (n >= t ? "met" : "behind");
  const progress = n === null || t === null || t <= 0 || direction === "at_most" ? null : Math.max(0, Math.min(1, n / t));
  return { ...metric, value, observed_at: score?.observed_at ?? null, source: score?.source ?? null, standing, progress };
}
export const metricReadings = (row: Pick<InitiativeRow, "metrics" | "scoreboard">): MetricReading[] => (row.metrics ?? []).map((m) => metricReading(m, row.scoreboard?.[m.key]));

/** "Weekly active teams: 412 of 1,000, behind (28 Sep)" or "Weekly active teams: not reported yet, target 1,000". */
export function metricLine(r: MetricReading, now = Date.now()): string {
  if (r.value === null) return `${r.name}: not reported yet, target ${r.target}`;
  const when = r.observed_at ? ` (${dayWord(r.observed_at, now)})` : "";
  const word = r.standing === "met" ? "met" : r.standing === "behind" ? "behind" : "";
  return `${r.name}: ${r.value} of ${r.target}${word ? `, ${word}` : ""}${when}`;
}
function dayWord(at: number, now: number): string {
  const days = Math.floor((now - at) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  const d = new Date(at);
  return `${d.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]}`;
}

/** The goal's standing against its numbers as one word: behind if any metric is, met if every reported one is, else unknown. */
export function initiativeStanding(readings: MetricReading[]): MetricStanding {
  if (readings.some((r) => r.standing === "behind")) return "behind";
  if (readings.length && readings.every((r) => r.standing === "met")) return "met";
  return "unknown";
}

// ── The intent record (I5) ───────────────────────────────────────────────────

export const INTENT_SOURCE_KINDS = ["call", "chat", "doc", "session", "task", "plan", "link", "note"] as const;
export type IntentSourceKind = (typeof INTENT_SOURCE_KINDS)[number];

/**
 * Who said it and where. `ref` is the object's own address: a call id with an
 * optional `#line`, a chat message id, a doc id, a session short id with an
 * optional `:line`, `ct-N`, `pl-N`, or a URL. `quote` is the words as said.
 * A `note` has no address: its quote is all there is.
 */
export type IntentSource = { kind: IntentSourceKind; ref?: string; quote?: string; by?: string; at?: number };

export const INTENT_SOURCE_LABEL: Record<IntentSourceKind, string> = {
  call: "Call", chat: "Chat", doc: "Doc", session: "Session", task: "Task", plan: "Plan", link: "Link", note: "Note",
};

const QUOTE_MAX = 400;
const trimQuote = (text: string): string | undefined => {
  const t = text.trim().replace(/^[\s:,;-]+/, "").replace(/^["'“‘](.*)["'”’]$/s, "$1").trim();
  return t ? t.slice(0, QUOTE_MAX) : undefined;
};

/** One address read as a source kind and ref, or null when it is not an address. */
function readSourceRef(token: string): Pick<IntentSource, "kind" | "ref"> | null {
  const t = token.trim().replace(/[.,;:]+$/, "");
  if (!t) return null;
  if (/^https?:\/\/\S+$/i.test(t)) return { kind: "link", ref: t };
  if (/^ct-\d+$/i.test(t)) return { kind: "task", ref: t.toLowerCase() };
  if (/^pl-\d+$/i.test(t)) return { kind: "plan", ref: t.toLowerCase() };
  const named = t.match(/^(call|chat|doc|session|task|plan):(\S+)$/i);
  if (named) {
    const kind = named[1].toLowerCase() as IntentSourceKind;
    // A call line reads "call:<id>#14" or "call:<id>:14"; both store as "#14".
    const ref = kind === "call" ? named[2].replace(/:(\d+(?:-\d+)?)$/, "#$1") : named[2];
    return { kind, ref };
  }
  // A session short id, alone or with a line: "jx7c6zk", "jx7c6zk:142".
  if (/^(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{7}(?::\d+(?:-\d+)?)?$/.test(t)) return { kind: "session", ref: t };
  return null;
}

/**
 * Read a source the way people and the review write one: an address alone
 * ("call:k57abc#14", "jx7c6zk:142", "ct-12", a URL), an address followed by
 * the words said, or plain words, which are a note. Never throws: text that
 * names no address is still a record of what was said.
 */
export function parseIntentSource(text: string, extra: Pick<IntentSource, "by" | "at" | "quote"> = {}): IntentSource {
  const t = (text ?? "").trim();
  const [first, ...rest] = t.split(/\s+/);
  const ref = readSourceRef(first ?? "");
  const quote = extra.quote?.trim() ? trimQuote(extra.quote) : trimQuote(ref ? rest.join(" ") : t);
  const out: IntentSource = ref ? { ...ref } : { kind: "note" };
  if (quote) out.quote = quote;
  if (extra.by?.trim()) out.by = extra.by.trim().slice(0, 80);
  if (extra.at) out.at = extra.at;
  return out;
}

/** Two sources are the same when they name the same address, or say the same words with none. */
export const intentSourceKey = (s: IntentSource): string => `${s.kind}:${(s.ref ?? s.quote ?? "").trim().toLowerCase()}`;

/** "Call, line 14", "Session jx7c6zk, line 142", "ct-12", "Note". The words a link wears. */
export function intentSourceLabel(s: IntentSource): string {
  const ref = s.ref ?? "";
  switch (s.kind) {
    case "call": { const line = ref.match(/#(\d+(?:-\d+)?)$/)?.[1]; return line ? `Call, line ${line}` : "Call"; }
    case "session": { const [id, line] = ref.split(":"); return line ? `Session ${id}, line ${line}` : `Session ${id}`; }
    case "task": case "plan": return ref;
    case "link": { try { return new URL(ref).hostname.replace(/^www\./, ""); } catch { return "Link"; } }
    default: return INTENT_SOURCE_LABEL[s.kind];
  }
}

/** "Ashot on a call, 30 Sep: our goal is $250 or less per introduction" for a terminal and a prompt. */
export function intentSourceLine(s: IntentSource, now = Date.now()): string {
  const where = s.kind === "note" ? "" : s.ref && s.kind !== "task" && s.kind !== "plan" && s.kind !== "link" ? `${s.kind}:${s.ref}` : (s.ref ?? "");
  const head = [s.by, where, s.at ? dayWord(s.at, now) : ""].filter(Boolean).join(", ");
  return s.quote ? (head ? `${head}: "${s.quote}"` : `"${s.quote}"`) : head || "Note";
}

/** Add sources to a list, keeping the first of any two that are the same, capped at the list's limit. */
export function mergeIntentSources(prior: readonly IntentSource[] | undefined, more: readonly IntentSource[]): IntentSource[] {
  const out = [...(prior ?? [])];
  const seen = new Set(out.map(intentSourceKey));
  for (const s of more) {
    const k = intentSourceKey(s);
    if (seen.has(k) || k.endsWith(":")) continue;
    seen.add(k);
    out.push(s);
  }
  return out.slice(0, INITIATIVE_RECORD_MAX.sources);
}

/** A step on the way, with the day it is due and the moment it was reached. */
export type InitiativeMilestone = { key: string; title: string; date?: number; done_at?: number; source?: IntentSource };
/** Something still undecided. An answer closes it; the question stays on the record. */
export type InitiativeQuestion = { key: string; text: string; at: number; by?: string; source?: IntentSource; answer?: string; answered_at?: number };
/** Something that was decided, by whom and where. */
export type InitiativeDecision = { key: string; text: string; at: number; by?: string; source?: IntentSource };

/** The record's four lists and how many entries each holds. */
export const INITIATIVE_RECORD_LISTS = ["milestones", "questions", "decisions", "sources"] as const;
export type InitiativeRecordList = (typeof INITIATIVE_RECORD_LISTS)[number];
export const INITIATIVE_RECORD_MAX: Record<InitiativeRecordList, number> = { milestones: 12, questions: 20, decisions: 40, sources: 20 };
/** How many reported values a metric keeps: a year of weekly reports. */
export const INITIATIVE_SCORE_HISTORY_MAX = 52;

/** A short key for a new entry, unique within its list: a slug of its words, numbered on a clash. */
export function recordEntryKey(text: string, taken: readonly string[]): string {
  const base = metricKeyOf(text).slice(0, 32) || "entry";
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}_${n}`)) return `${base}_${n}`;
}

/** Milestones in reading order: dated ones by day, then undated ones as written. */
export function orderedMilestones(milestones: readonly InitiativeMilestone[] | undefined): InitiativeMilestone[] {
  return (milestones ?? []).map((m, i) => ({ m, i })).sort((a, b) => (a.m.date ?? Infinity) - (b.m.date ?? Infinity) || a.i - b.i).map((x) => x.m);
}
/** The next milestone: the first one not reached, earliest day first. Null when every one is reached or none is set. */
export const nextMilestone = (row: Pick<InitiativeRow, "milestones">): InitiativeMilestone | null => orderedMilestones(row.milestones).find((m) => !m.done_at) ?? null;
/** "3 of 5 reached" as counts. */
export const milestoneCounts = (row: Pick<InitiativeRow, "milestones">): { done: number; total: number } => ({ done: (row.milestones ?? []).filter((m) => m.done_at).length, total: (row.milestones ?? []).length });
export const openQuestions = (row: Pick<InitiativeRow, "questions">): InitiativeQuestion[] => (row.questions ?? []).filter((q) => !q.answer);

/** Add a reported value to a metric's history, oldest first, the newest INITIATIVE_SCORE_HISTORY_MAX kept. A second report for the same moment replaces the first. */
export function appendScoreHistory(history: Record<string, InitiativeScore[]> | undefined, key: string, score: InitiativeScore): Record<string, InitiativeScore[]> {
  const series = [...(history?.[key] ?? []).filter((s) => s.observed_at !== score.observed_at), score].sort((a, b) => a.observed_at - b.observed_at);
  return { ...(history ?? {}), [key]: series.slice(-INITIATIVE_SCORE_HISTORY_MAX) };
}

export type MetricTrend = {
  /** Which way the number moved between the first and the last report read. */
  direction: "up" | "down" | "flat" | "unknown";
  /** Whether that is toward the target; null when flat or unknown. */
  toward: boolean | null;
  /** The change between the previous report and the latest, as a number; null when either is unread. */
  delta: number | null;
  /** The readable values oldest first, for a sparkline. */
  series: Array<{ at: number; n: number }>;
};

/** A metric's history read as a direction and a series. `window` is how many of the latest reports to read. */
export function metricTrend(history: readonly InitiativeScore[] | undefined, target: string, window = 12): MetricTrend {
  const series = (history ?? []).map((s) => ({ at: s.observed_at, n: metricNumber(s.value) })).filter((p): p is { at: number; n: number } => p.n !== null).sort((a, b) => a.at - b.at).slice(-window);
  if (series.length < 2) return { direction: "unknown", toward: null, delta: null, series };
  const first = series[0].n, last = series[series.length - 1].n;
  const span = Math.max(Math.abs(first), Math.abs(last), 1e-9);
  const direction = Math.abs(last - first) / span < 0.005 ? "flat" : last > first ? "up" : "down";
  const toward = direction === "flat" ? null : (metricDirection(target) === "at_most") === (direction === "down");
  return { direction, toward, delta: last - series[series.length - 2].n, series };
}
export const metricTrends = (row: Pick<InitiativeRow, "metrics" | "score_history">): Record<string, MetricTrend> => Object.fromEntries((row.metrics ?? []).map((m) => [m.key, metricTrend(row.score_history?.[m.key], m.target)]));

/** "up from 380, toward the target" for a terminal and a prompt; empty before two reports. */
export function trendWords(t: MetricTrend): string {
  if (t.direction === "unknown") return "";
  if (t.direction === "flat") return "flat";
  const from = t.series[0]?.n;
  return `${t.direction}${from !== undefined ? ` from ${formatMetricNumber(from)}` : ""}${t.toward === null ? "" : t.toward ? ", toward the target" : ", away from the target"}`;
}
/** 1234.5 → "1,234.5"; whole numbers print whole. */
export const formatMetricNumber = (n: number): string => (Number.isInteger(n) ? n : Math.round(n * 100) / 100).toLocaleString("en-US");

export type InitiativeLink = { short_id: string; title: string };
/**
 * The goals above this one, nearest first, up to the top level goal: what a
 * role's work feeds. Cycles and missing rows end the walk.
 */
export function initiativeChain<T extends { _id: string; short_id: string; title: string; parent_initiative_id?: string }>(row: T, byId: (id: string) => T | undefined): InitiativeLink[] {
  const out: InitiativeLink[] = [];
  const seen = new Set<string>([row._id]);
  let cur: T | undefined = row;
  while (cur?.parent_initiative_id && !seen.has(cur.parent_initiative_id)) {
    seen.add(cur.parent_initiative_id);
    cur = byId(cur.parent_initiative_id);
    if (!cur) break;
    out.push({ short_id: cur.short_id, title: cur.title });
  }
  return out;
}
/** "Win the private network, under Reach 1k teams" */
export const chainLine = (chain: InitiativeLink[]): string => chain.length ? `under ${chain.map((c) => c.title).join(", under ")}` : "";

export type InitiativeRow = {
  _id: string;
  /** "in-N". */
  short_id: string;
  /** The optimistic stub's own key; the server row carrying it supersedes the stub. */
  client_key?: string;
  title: string;
  /** The goal in a few sentences: its scope and context. */
  description?: string;
  status: InitiativeStatus;
  /** Absent means nobody drives it, which is the first finding of a review. */
  owner?: InitiativeOwner;
  target_date?: number;
  priority?: InitiativePriority;
  labels?: string[];
  /** Project ids in the order the owner arranged them. A project may sit in several initiatives. */
  project_ids: string[];
  /** One level of nesting: a row that has a parent is never a parent itself. The parent is the top level goal this one feeds. */
  parent_initiative_id?: string;
  /** One or two numbers the goal is measured by, each with a target (at most INITIATIVE_METRICS_MAX). */
  metrics?: InitiativeMetric[];
  /** The reported values by metric key, with a source and a date each (the template scoreboard's shape). The latest of `score_history`. */
  scoreboard?: Record<string, InitiativeScore>;
  /** Every reported value by metric key, oldest first (I5): what the trend is read from. Written only with `scoreboard`. */
  score_history?: Record<string, InitiativeScore[]>;
  /** Why it matters. */
  why?: string;
  /** What done looks like: the sentence a result is checked against. */
  done_when?: string;
  /** Steps on the way; the next one is the first not reached (nextMilestone). */
  milestones?: InitiativeMilestone[];
  /** What is still undecided, and what was answered. */
  questions?: InitiativeQuestion[];
  /** What was decided, newest last. */
  decisions?: InitiativeDecision[];
  /** Where the goal was stated: who said it and where. */
  sources?: IntentSource[];
  /** Copied from the latest update when it is posted; `none` before one exists. */
  health: InitiativeHealth;
  /** When the latest update was posted, so a list shows the date with no updates loaded. */
  health_at?: number;
  latest_update_id?: string;
  /** ACCESS. */
  workspace: string;
  /** ROUTING. */
  team_id?: string;
  /** Who created it. Named `user_id` because the access stamp reads that field on every table. */
  user_id: string;
  created_at: number;
  updated_at: number;
};

export type InitiativeUpdateRow = {
  _id: string;
  client_key?: string;
  initiative_id: string;
  body: string;
  health: InitiativeUpdateHealth;
  by: InitiativeUpdateAuthor;
  at: number;
  workspace: string;
  user_id: string;
};

/** Reads `in-7`, `IN-7` and a bare `7` as the short id; anything else is returned untouched (a Convex id). */
export function normalizeInitiativeRef(ref: string): string {
  const t = (ref || "").trim();
  if (/^\d+$/.test(t)) return `in-${t}`;
  return /^in-\d+$/i.test(t) ? t.toLowerCase() : t;
}
