// The learning loop (docs/architecture/org-hire.md H12): what an opted-in
// workspace is told, the signals read from one instance, the request that
// turns them into generalized lessons, the check that refuses a lesson carrying
// anything of the workspace, and the rules for when lessons become a release
// and a canary becomes stable. Pure, so the server (the pass), the CLI (status)
// and the web (the switch) read one definition.
import { compareVersions, intervalMs, type OrgTemplate } from "./orgTemplateManifest";
import type { RoutineReadiness } from "./orgTemplateReadiness";
import type { InstanceState } from "./orgTemplateState";

/** The switch's label and its one sentence: what leaves the workspace and what comes back. */
export const LEARNING_OPT_IN_LABEL = "Let Codecast learn from this workspace's template roles";
export const LEARNING_OPT_IN_SENTENCE = "Codecast reads how these roles were corrected and where they stalled, on its own servers, and keeps only generalized lessons about the template: never transcripts, quotes, names, customer data or code. In return, the templates you use improve.";

const DAY = 86_400_000;
export const LEARNING = {
  /** A first pass reads this far back; later passes read from the last one. */
  first_window_ms: 14 * DAY,
  /** A setup step open this long after the hire, or a ready routine nobody turned on, is a stall. */
  stall_ms: 7 * DAY,
  /** A routine not ready this long after the hire is blocked. */
  blocked_ms: 14 * DAY,
  redirects: 30,
  said_chars: 600,
  before_chars: 300,
  /** Rules a role taught itself (its playbook, org-staffing.md S38) one pass reads, newest first, each clipped. */
  rules: 12,
  rule_chars: 400,
  lessons_per_pass: 8,
  lesson_chars: 1200,
  /** Structural signals already taught, kept on the instance so one stall teaches once. */
  seen_cap: 200,
  /** A draft is due at this many open lessons, or when one has waited this long. */
  draft_at_lessons: 3,
  draft_at_age_ms: 14 * DAY,
  /** A canary release soaks this long before it may become stable. */
  canary_soak_ms: 3 * DAY,
} as const;

export const LESSON_KINDS = ["redirect", "setup", "routine", "evidence", "rule"] as const;
export type LessonKind = (typeof LESSON_KINDS)[number];
export type LearnedLesson = { kind: LessonKind; about: string; lesson: string };

// ── Signals ─────────────────────────────────────────────────────────────────

/** A person's line to the role, with the role's line before it. */
export type Redirect = { before?: string; said: string };
/** A stall or failure read off the instance's record. `key` is what the instance remembers; `line` is in the template's own words. */
export type StructuralSignal = { key: string; kind: Exclude<LessonKind, "redirect">; about: string; line: string; detail?: string };
/** A rule the role wrote in its own playbook, with the mistake that taught it. `key` is what the instance remembers, so a rule teaches once. */
export type LearnedRule = { key: string; rule: string; mistake?: string };
export type LearningDigest = { redirects: Redirect[]; signals: StructuralSignal[]; rules?: LearnedRule[] };
export type LearningRoutine = { id: string; external?: boolean; retired?: boolean; trigger: { status: string; run_count?: number; last_run_at?: number; last_run_failed?: boolean; last_run_summary?: string } | null };

const days = (ms: number) => Math.max(1, Math.floor(ms / DAY));

/**
 * Where the instance stalled or failed, from its record alone: setup steps
 * left open or skipped, routines that failed, sat ready or stayed blocked,
 * evidence that failed or went stale. Titles are the manifest's, never the
 * instance's filled text, so a line carries nothing of the workspace.
 */
export function structuralSignals(manifest: OrgTemplate, input: { state: InstanceState; readiness: Record<string, RoutineReadiness>; routines: LearningRoutine[]; hired_at: number; seen?: string[] }, now = Date.now()): StructuralSignal[] {
  const out: StructuralSignal[] = [];
  const age = now - input.hired_at;
  for (const item of manifest.setup ?? []) {
    const status = input.state.setup?.[item.id]?.status ?? "open";
    const whose = item.who === "human" ? "a person's step" : "the role's own step";
    if (status === "skipped") out.push({ key: `setup:${item.id}:skipped`, kind: "setup", about: item.id, line: `Setup step ${item.id} (${whose}: ${item.title}) was skipped.` });
    else if (status === "open" && age >= LEARNING.stall_ms) out.push({ key: `setup:${item.id}:open`, kind: "setup", about: item.id, line: `Setup step ${item.id} (${whose}: ${item.title}) is still open ${days(age)} days after the hire.` });
  }
  for (const routine of manifest.routines) {
    const row = input.routines.find((r) => r.id === routine.id);
    if (!row || row.external || row.retired) continue;
    const t = row.trigger;
    const ready = input.readiness[routine.id];
    if (t?.last_run_failed && t.last_run_at) out.push({ key: `routine:${routine.id}:failed:${t.last_run_at}`, kind: "routine", about: routine.id, line: `Routine ${routine.id} (${routine.title}) failed its last run.`, detail: t.last_run_summary });
    if (t?.status === "paused" && !t.run_count) {
      if (ready?.ready && age >= LEARNING.stall_ms) out.push({ key: `routine:${routine.id}:idle`, kind: "routine", about: routine.id, line: `Routine ${routine.id} (${routine.title}) has been ready for a person to turn on and nobody has, ${days(age)} days after the hire.` });
      else if (ready && !ready.ready && age >= LEARNING.blocked_ms) out.push({ key: `routine:${routine.id}:blocked`, kind: "routine", about: routine.id, line: `Routine ${routine.id} (${routine.title}) is still not ready ${days(age)} days after the hire: ${ready.missing.join("; ")}.` });
    }
  }
  for (const check of manifest.evidence ?? []) {
    const record = input.state.evidence?.[check.id];
    if (!record) continue;
    if (record.status === "fail") out.push({ key: `evidence:${check.id}:fail:${record.observed_at}`, kind: "evidence", about: check.id, line: `Evidence check ${check.id} (${check.title}) last recorded a failure.` });
    else if (now - record.observed_at > intervalMs(check.max_age)) out.push({ key: `evidence:${check.id}:stale:${record.observed_at}`, kind: "evidence", about: check.id, line: `Evidence check ${check.id} (${check.title}) passed ${days(now - record.observed_at)} days ago and is good for ${check.max_age}: it went stale.` });
  }
  const seen = new Set(input.seen ?? []);
  return out.filter((s) => !seen.has(s.key));
}

/**
 * The rules in a role's playbook the instance has not been taught from yet,
 * newest first. A rule is the role's own generalization of a mistake, which
 * is the closest thing in a workspace to a lesson already; it still goes to
 * the model as a signal, never to the publisher as written.
 */
export function playbookRuleSignals(rules: ReadonlyArray<{ text: string; mistake: string | null; written_at: number | null }>, seen: readonly string[] = []): LearnedRule[] {
  const known = new Set(seen);
  return [...rules]
    .sort((a, b) => (b.written_at ?? 0) - (a.written_at ?? 0))
    .map((r) => ({ key: `rule:${textKey(`${r.text} ${r.mistake ?? ""}`)}`, rule: r.text, ...(r.mistake ? { mistake: r.mistake } : {}) }))
    .filter((r) => r.rule.length >= 12 && !known.has(r.key))
    .slice(0, LEARNING.rules);
}
/** A short stable key for a sentence: case, spacing and punctuation do not change it. */
function textKey(text: string): string {
  let h = 5381;
  for (const ch of text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()) h = ((h << 5) + h + ch.codePointAt(0)!) >>> 0;
  return h.toString(36);
}

// ── The extraction request ──────────────────────────────────────────────────

export const LEARNING_SYSTEM = `You improve a role template that many workspaces hire. A template is a standing job handed to an agent: a charter, routines that run on a schedule, setup steps a person or the role does once, and evidence checks that gate the routines.

You are given what happened on one workspace's hire of the template: what people typed to the role, each with the role's line before it, where its setup, routines and evidence stalled or failed, and the rules the role wrote down for itself, each with the mistake that taught it.

Find what the template itself should do differently so the same thing does not happen on the next workspace: an instruction that was missing or misleading, a setup step that asks too much or explains too little, a routine that fails or goes unused, a check that goes stale. Most of what people say to a role is them steering their own work, a new task or a preference about their own product, and teaches the template nothing. A rule the role taught itself is mostly about its own workspace too; it is a lesson only when any workspace's hire of this template would make the same mistake without it. When nothing generalizes, the empty answer is the right one.

Every lesson leaves this workspace and is read by the template's publisher, who must learn nothing about the workspace from it. Write each lesson as a statement about the template in your own words: what went wrong in general terms, and what the template should say or do instead. Carry over no name of a person, company, product or project, no address, link or domain, no id or number that points at something in the workspace, nobody's words in quotation, and no code. The template's own vocabulary, the ids listed under Template, is fine to use.

Reply with JSON only: an array of {"kind": "redirect" | "setup" | "routine" | "evidence" | "rule" (a lesson drawn from the role's own rules), "about": one of the template's ids or "charter", "lesson": one to three sentences}. Reply [] when nothing generalizes.`;

const clip = (text: string, chars: number) => (text.length > chars ? `${text.slice(0, chars)}…` : text);

/** The one request a pass sends for one instance: the template in its own words, then the instance's signals. */
export function learningRequest(manifest: OrgTemplate, digest: LearningDigest): { system: string; prompt: string } {
  const list = (rows: string[]) => (rows.length ? rows.map((r) => `- ${r}`).join("\n") : "- none");
  const template = [
    `Template ${manifest.id} ${manifest.version}: ${manifest.name}. ${manifest.description}`,
    `Routines:\n${list(manifest.routines.map((r) => `${r.id}: ${r.title} (every ${r.every})`))}`,
    `Setup steps:\n${list((manifest.setup ?? []).map((s) => `${s.id}: ${s.title} (${s.who === "human" ? "a person's" : "the role's"})`))}`,
    `Evidence checks:\n${list((manifest.evidence ?? []).map((e) => `${e.id}: ${e.title} (good for ${e.max_age})`))}`,
  ].join("\n\n");
  const signals = digest.signals.map((s) => (s.detail ? `${s.line} The role's summary of it: ${clip(s.detail, LEARNING.said_chars)}` : s.line));
  const redirects = digest.redirects.map((r, i) => `${i + 1}. ${r.before ? `The role had said: ${clip(r.before, LEARNING.before_chars)}\n   ` : ""}A person then typed: ${clip(r.said, LEARNING.said_chars)}`);
  const rules = (digest.rules ?? []).map((r) => `${clip(r.rule, LEARNING.rule_chars)}${r.mistake ? ` It learned this from: ${clip(r.mistake, LEARNING.rule_chars)}` : ""}`);
  return { system: LEARNING_SYSTEM, prompt: `# Template\n\n${template}\n\n# Where this hire stalled or failed\n\n${list(signals)}\n\n# What people typed to the role\n\n${redirects.length ? redirects.join("\n") : "Nothing."}\n\n# Rules the role taught itself\n\n${list(rules)}` };
}

/** The reply as lessons: malformed entries are dropped, an unknown `about` falls back to the charter. */
export function parseLessons(raw: unknown, manifest: OrgTemplate): LearnedLesson[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set([...manifest.routines.map((r) => r.id), ...(manifest.setup ?? []).map((s) => s.id), ...(manifest.evidence ?? []).map((e) => e.id)]);
  const out: LearnedLesson[] = [];
  for (const entry of raw) {
    const lesson = typeof entry?.lesson === "string" ? entry.lesson.trim() : "";
    if (lesson.length < 20 || lesson.length > LEARNING.lesson_chars || !LESSON_KINDS.includes(entry.kind)) continue;
    out.push({ kind: entry.kind, about: ids.has(entry.about) ? entry.about : "charter", lesson });
    if (out.length === LEARNING.lessons_per_pass) break;
  }
  return out;
}

// ── The check: nothing of the workspace leaves in a lesson ──────────────────

export const LEAK_KINDS = ["email", "url", "id", "quote", "code", "name"] as const;
export type LeakKind = (typeof LEAK_KINDS)[number];

const PATTERNS: Array<[LeakKind, RegExp]> = [
  ["email", /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/],
  ["url", /\bhttps?:\/\/|\bwww\.[a-z0-9-]+\.|\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|io|dev|app|ai|co|sh|email|xyz|so)\b/i],
  // Codecast short ids, session ids, UUIDs, long hex and storage ids, tracker ids, issue numbers.
  ["id", /\b(?:ct|pl|tr|or|op|ds|sd|pr)-\d+\b|\bdoc:[a-z0-9]+|\bjx[a-z0-9]{5}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-|\b[0-9a-f]{12,}\b|\b[a-z0-9]{32}\b|\b[A-Z]{2,6}-\d{2,}\b|#\d{2,}\b/],
  ["code", /```/],
  ["quote", /^\s*>/m],
];
const QUOTED = /["“]([^"”\n]*)["”]/g;
const QUOTE_WORDS = 5;
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Why a lesson may not leave the workspace, by kind; empty when it may. A
 * quoted passage of five words or more is somebody's words. A term is a name
 * from the workspace (workspaceTerms): one plain word matches as written, so
 * a project called Growth does not refuse the word growth; anything longer or
 * shaped like a slug, a domain or a handle matches in any case.
 */
export function lessonLeaks(text: string, terms: string[] = []): LeakKind[] {
  const found = new Set<LeakKind>();
  for (const [kind, re] of PATTERNS) if (re.test(text)) found.add(kind);
  for (const match of text.matchAll(QUOTED)) if (match[1]!.trim().split(/\s+/).length >= QUOTE_WORDS) found.add("quote");
  for (const term of terms) {
    const plainWord = /^\p{L}+$/u.test(term);
    if (new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, plainWord ? "u" : "iu").test(text)) { found.add("name"); break; }
  }
  return LEAK_KINDS.filter((kind) => found.has(kind));
}

/** Words that belong to the platform, not to any workspace. */
const PLATFORM_WORDS = ["codecast", "cast", "template", "role", "project", "team", "workspace"];
export type WorkspaceFacts = {
  people?: Array<{ name?: string | null; email?: string | null; github_username?: string | null }>;
  team?: string | null;
  projects?: Array<string | null | undefined>;
  instance?: string;
  handle?: string | null;
  /** Hire answers by input key; only free-text answers that look like a name or an address count. */
  config?: Record<string, string>;
  host?: { machine?: string; dir?: string } | null;
};

/**
 * The names a lesson from this workspace must not carry: its people, team,
 * projects, the instance and its handle, identifying answers and its host.
 * The template's own words and the platform's are not the workspace's, so a
 * team called Codecast or a project called Growth on the growth template
 * does not refuse every lesson.
 */
export function workspaceTerms(facts: WorkspaceFacts, manifest: OrgTemplate): string[] {
  const vocabulary = new Set([...PLATFORM_WORDS, ...[manifest.id, manifest.name, manifest.description, manifest.role.name, ...manifest.routines.flatMap((r) => [r.id, r.title]), ...(manifest.setup ?? []).flatMap((s) => [s.id, s.title]), ...(manifest.evidence ?? []).flatMap((e) => [e.id, e.title])].join(" ").toLowerCase().split(/[^\p{L}\p{N}]+/u)]);
  const terms = new Set<string>();
  const add = (value: string | null | undefined, opts: { words?: boolean } = {}) => {
    const term = (value ?? "").trim();
    if (term.length < 3 || /^\d+$/.test(term) || vocabulary.has(term.toLowerCase())) return;
    terms.add(term);
    if (opts.words && /\s/.test(term)) for (const word of term.split(/\s+/)) add(word);
  };
  for (const person of facts.people ?? []) {
    add(person.name, { words: true });
    add(person.email);
    add(person.email?.split("@")[0]);
    add(person.github_username);
  }
  add(facts.team, { words: true });
  for (const title of facts.projects ?? []) add(title, { words: true });
  add(facts.instance);
  add(facts.handle);
  const declared = new Map((manifest.inputs ?? []).map((i) => [i.key, i.kind]));
  for (const [key, value] of Object.entries(facts.config ?? {})) {
    if (declared.get(key) !== "string" || !(/[A-Z0-9./@_-]/.test(value) || /\s/.test(value.trim()))) continue;
    add(value);
  }
  add(facts.host?.machine);
  add(facts.host?.dir);
  add(facts.host?.dir?.split(/[\\/]/).filter(Boolean).at(-1));
  return [...terms];
}

// ── From lessons to a release, from canary to stable ────────────────────────

/** Open lessons are enough for a draft at three, or when one has waited two weeks. */
export function draftDue(lessons: Array<{ status: string; created_at: number }>, now = Date.now()): { due: boolean; open: number; why: string } {
  const open = lessons.filter((l) => l.status === "open");
  if (open.length >= LEARNING.draft_at_lessons) return { due: true, open: open.length, why: `${open.length} open lessons` };
  const oldest = Math.min(...open.map((l) => l.created_at));
  if (open.length && now - oldest >= LEARNING.draft_at_age_ms) return { due: true, open: open.length, why: `an open lesson has waited ${days(now - oldest)} days` };
  return { due: false, open: open.length, why: open.length ? `${open.length} open lesson${open.length === 1 ? "" : "s"}, none older than ${days(LEARNING.draft_at_age_ms)} days` : "no open lessons" };
}

export type CanaryInstance = { on_release: boolean; ran: boolean; failed: boolean };
/**
 * Whether a canary release ran clean: it soaked, at least one canary instance
 * runs it, each of those completed a routine run on it, none failed its last
 * run, and no lesson learned since names that version. With no canary
 * instance on it nothing is known, so a person promotes.
 */
export function canaryVerdict(input: { published_at: number; instances: CanaryInstance[]; lessons_since: number }, now = Date.now()): { clean: boolean; why: string } {
  const on = input.instances.filter((i) => i.on_release);
  if (!on.length) return { clean: false, why: input.instances.length ? "no canary instance has taken the release yet" : "no instance follows canary: a person promotes" };
  if (on.some((i) => i.failed)) return { clean: false, why: "a canary instance failed its last run on this release" };
  if (input.lessons_since) return { clean: false, why: `${input.lessons_since} lesson${input.lessons_since === 1 ? " was" : "s were"} learned on this release` };
  if (on.some((i) => !i.ran)) return { clean: false, why: "a canary instance has not completed a run on this release yet" };
  const soaked = now - input.published_at;
  if (soaked < LEARNING.canary_soak_ms) return { clean: false, why: `canary for ${Math.floor(soaked / 3_600_000)} hours of ${LEARNING.canary_soak_ms / 3_600_000}` };
  return { clean: true, why: `${on.length} canary instance${on.length === 1 ? "" : "s"} ran clean for ${days(soaked)} days` };
}

/** The version a learned draft takes: the next patch after the newest release. */
export function nextPatch(versions: string[]): string {
  const newest = [...versions].sort(compareVersions).at(-1) ?? "0.0.0";
  const [major, minor, patch] = newest.split(".").map(Number);
  return `${major}.${minor}.${(patch ?? 0) + 1}`;
}
