// The judge route's two tools (docs/architecture/learning-loop.md LL11): a
// problem that gathers cases against a judge is fixed in an edited copy of
// the product's .codecast (the judge's prompt or the extractor of its
// moment), measured against what is published now on the very moments the
// cases were ruled on, and brought to the project's reviewer as one card.
//
//   cast line judges arm --task <ct-N> --dir <dir>
//     The cases (each finding the judge got wrong, its moment, the expectation
//     it named and what a correct judgment does) into <dir>/cases.json, and an
//     edited copy at <dir>/arm: .codecast/judges and .codecast/moments copied,
//     every other top-level entry of the checkout linked, so an extractor's
//     relative reads resolve as they do in the checkout.
//   cast line judges base --task <ct-N> --dir <dir> [--reps 5]
//     Before any fix: what is published judges each ruled case reps times. A
//     case filed again at most once in five is a draw the judge does not
//     repeat; draws leave cases.json, and when every case is one the outcome
//     is "draws" and the problem closes with no fix (no card).
//   cast line judges ab --task <ct-N> --dir <dir> [--reps 5] [--controls 10] [--budget 8] --change "<sentence>"
//     Judges each ruled case (one per distinct message, however many moments
//     show it) and each control (a live finding of the same
//     judge) on both sides, reps times, on the team's budget; a changed
//     extractor re-extracts both sides from the product's own data. Writes
//     the card (<dir>/judge-fix.json, shared/contracts/judgeFix.ts) and exits
//     0 only when the ruled cases separate and the controls do not get worse.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "./proc.js";
import type { Command } from "commander";
import { fmt } from "./colors.js";
import { apiPost, type PublishDeps } from "./castApi.js";
import { scopeFor } from "./lineScope.js";
import { JUDGES_DIR, MOMENTS_DIR, fileVersion, runExtractor, shadowDir } from "./momentsHost.js";
import { judgeBackendOf, judgeBackendOption, judgeCall, momentForTry, repoRoot } from "./judgingCommand.js";
import { briefAt, evidenceMessage, evidenceScopes, evidenceSubject, judgeRequest, narrowBrief, parseJudgeReply, parseJudgeSpec, rulingsShown, type ExpectationsBrief, type JudgeRuling, type JudgeSpec } from "@codecast/shared/contracts/judges";
import { parseExtractorHeader, type JudgeBackend, type MomentRecord } from "@codecast/shared/contracts/moments";
import { isJudgeCaseKey, type CaseTarget } from "@codecast/shared/contracts/judgeReview";
import { caseMoved, fisherOneSided, JUDGE_FIX_ALPHA, restEmptied, judgeFixGroup, judgeFixVerdict, validateJudgeFixCard, type JudgeFixCard, type JudgeFixCase, type JudgeFixKept, type JudgeFixRest } from "@codecast/shared/contracts/judgeFix";

function fail(message: string, code = 2): never {
  console.error(fmt.error(message));
  process.exit(code);
}

/** One ruled case as the route reads it. */
export type RuledCase = {
  case: string;
  finding: string;
  judge: string;
  moment: string;
  expectation: string;
  against: CaseTarget;
  said: string;
  correct: string;
  /** The words the ruled finding quoted: they place the message the ruling is about. */
  quote?: string;
  fact?: string;
  why?: string;
};

export type CasesFile = {
  task: string;
  title: string;
  project_id: string;
  judges: string[];
  /** The parts the cases name, each with its file in the checkout. */
  parts: Array<{ against: CaseTarget; name: string; file: string }>;
  cases: RuledCase[];
  root: string;
  /** The checkout's .codecast as it stood when the copy was made: what the edit is measured against, so another session's later edit is never read as part of this one. */
  base?: string;
  arm: string;
  /** Other judge fixes waiting for their reviewer when this one was laid out or measured, whose edits this base and copy carry (oldest first). */
  stacked?: StackedFix[];
};

/** A waiting judge fix this one is built on: its edits sit in both this base and this copy, so it publishes first. */
export type StackedFix = { problem: string; card: string; dir: string; files: string[] };

const against = (key: string, answer?: string): CaseTarget =>
  key.startsWith("extractor:") ? "extractor" : key.startsWith("judge-input:") ? "input" : key.startsWith("judge:") ? "judge" : answer === "missing" ? "extractor" : "judge";

/** The files a case's part lives in: the judge's prompt, or the extractor of the moment's kind. */
function partFile(c: { against: CaseTarget; judge: string }, kindOf: (judge: string) => string | null): { name: string; file: string } | null {
  if (c.against === "judge") return { name: `the ${c.judge} judge's prompt`, file: `${JUDGES_DIR}/${c.judge}.md` };
  const kind = kindOf(c.judge);
  return kind ? { name: `the ${kind} extractor`, file: `${MOMENTS_DIR}/${kind}.ts` } : null;
}

/** The lines removed from `a` and added in `b`, in order (a line diff good enough for a card). */
export function lineDiff(a: string, b: string): { removed: string[]; added: string[] } {
  const A = a.split("\n");
  const B = b.split("\n");
  const inB = new Map<string, number>();
  for (const l of B) inB.set(l, (inB.get(l) ?? 0) + 1);
  const inA = new Map<string, number>();
  for (const l of A) inA.set(l, (inA.get(l) ?? 0) + 1);
  const take = (lines: string[], other: Map<string, number>) => {
    const left = new Map(other);
    return lines.filter((l) => {
      const n = left.get(l) ?? 0;
      if (n > 0) { left.set(l, n - 1); return false; }
      return l.trim().length > 0;
    });
  };
  return { removed: take(A, inB), added: take(B, inA) };
}

/** Every file under `rel` in both roots that differs, as path relative to the root. */
function changedFiles(root: string, arm: string, rel: string): string[] {
  const out: string[] = [];
  const walk = (r: string) => {
    const dir = path.join(arm, r);
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(r, name);
      if (fs.statSync(path.join(arm, p)).isDirectory()) { walk(p); continue; }
      const base = path.join(root, p);
      if (!fs.existsSync(base) || fs.readFileSync(base, "utf8") !== fs.readFileSync(path.join(arm, p), "utf8")) out.push(p);
    }
  };
  walk(rel);
  return out.sort();
}

/** The words a finding quoted, from its detail's quote lines. */
const quoteOfDetail = (detail?: string) => String(detail ?? "").split("\n").filter((l) => l.startsWith("> ")).map((l) => l.slice(2)).join(" ").trim();

/** What one judge run found: each finding's expectation and quote, and the judge's own words when the run kept them. A run cached before quotes were kept reads as its expectations alone. */
export type RunFound = Array<{ expectation: string; quote: string; what_happened?: string; severity?: number }>;
export const readRunFound = (raw: unknown): RunFound => (Array.isArray(raw) ? raw.map((x) => (typeof x === "string" ? { expectation: x, quote: "" } : {
  expectation: String(x?.expectation ?? ""), quote: String(x?.quote ?? ""),
  ...(x?.what_happened ? { what_happened: String(x.what_happened) } : {}), ...(typeof x?.severity === "number" ? { severity: x.severity } : {}),
})) : []);

/** One run of the A/B as <dir>/ab-runs.jsonl keeps it: what the judge said on that side, so a reviewer reads its words before and after, not only counts. `cached` runs were reused from ab-base.jsonl. */
export type AbRun = { side: Side; moment: string; judge: string; rep: number; cached?: true; findings: RunFound | null };
export const abRunLines = (runs: AbRun[]) => runs.map((r) => JSON.stringify(r)).join("\n") + (runs.length ? "\n" : "");

/**
 * The ruled cases as distinct messages: cases whose ruled quote sits in one
 * message under one expectation are one case however many moments show it (a
 * contact's conversation and a match render the same email), the first
 * standing for the rest, which ride on it as twins. `messageOf` names a
 * case's message, or null when its quote places none (the case is then its
 * own).
 */
export function ruledByMessage<C extends { moment: string; finding: string; expectation: string }>(cases: C[], messageOf: (c: C) => string | null): Array<C & { message: string | null; twins: Array<{ moment: string; finding: string }> }> {
  const out = new Map<string, C & { message: string | null; twins: Array<{ moment: string; finding: string }> }>();
  for (const c of cases) {
    const message = messageOf(c);
    const key = `${message ?? `moment ${c.moment}`}|${c.expectation}`;
    const first = out.get(key);
    if (!first) out.set(key, { ...c, message, twins: [] });
    else if (first.moment !== c.moment || first.finding !== c.finding) first.twins.push({ moment: c.moment, finding: c.finding });
  }
  return [...out.values()];
}

/** The cases a judge-route problem holds, each with the finding it rules on. */
async function readCases(deps: PublishDeps, task: string): Promise<{ title: string; project_id: string; cases: RuledCase[] }> {
  const ls = await apiPost(deps, "/cli/signal/ls", { task, limit: 200 }, { read: true });
  const rows: any[] = (ls.signals ?? []).filter((s: any) => !s.retired);
  if (!rows.length) fail(`${task} holds no live findings`);
  if (!rows.every((s: any) => isJudgeCaseKey(s.fingerprint ?? ""))) fail(`${task} is not a judge-route problem: its findings are not cases against a judge`);
  const cases: RuledCase[] = [];
  // A split's own record names no ruled finding; the cases are the rest.
  for (const s of rows.filter((r: any) => r.case_of)) {
    const shown = await apiPost(deps, "/cli/signal/show", { signal: s.case_of }, { read: true });
    const f = shown.signal ?? shown;
    const review = f.judge_review ?? {};
    cases.push({
      case: s.short_id,
      finding: f.short_id,
      judge: f.judge ?? s.judge,
      moment: f.moment ?? s.moment,
      expectation: f.subject,
      against: review.against ?? against(s.fingerprint, review.answer),
      said: String(f.title ?? "").slice(0, 400),
      quote: quoteOfDetail(f.detail_md),
      correct: String(review.sentence ?? review.note ?? "").slice(0, 600),
      ...(review.fact ? { fact: String(review.fact).slice(0, 600) } : {}),
      ...(review.why ? { why: String(review.why).slice(0, 800) } : {}),
    });
  }
  return { title: rows[0].task_title ?? task, project_id: rows[0].project_id, cases: cases.filter((c) => c.moment && c.expectation) };
}

/** The edited copy: .codecast's judges and moments copied, the rest of the checkout linked in place. */
export function layOutArm(root: string, arm: string): void {
  fs.mkdirSync(path.join(arm, ".codecast"), { recursive: true });
  for (const dir of [JUDGES_DIR, MOMENTS_DIR]) {
    const from = path.join(root, dir);
    if (fs.existsSync(from) && !fs.existsSync(path.join(arm, dir))) fs.cpSync(from, path.join(arm, dir), { recursive: true });
  }
  for (const name of fs.readdirSync(root)) {
    if (name === ".codecast" || name === ".git") continue;
    const link = path.join(arm, name);
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(root, name), link);
  }
}

export type MomentShown = { moment: any; body: any };

export async function showMoment(deps: PublishDeps, scope: Record<string, unknown>, ref: string): Promise<MomentShown> {
  const shown = await apiPost(deps, "/cli/moments/show", { ...scope, moment: ref }, { read: true });
  let body: any = shown.moment.kept ? await apiPost(deps, "/cli/moments/body", { ...scope, moment: ref }, { read: true }) : null;
  const local = path.join(shadowDir(), String(shown.moment.source ?? "").replace(/[^A-Za-z0-9_-]/g, "_"), `${shown.moment.short_id}.json`);
  if (!body && fs.existsSync(local)) body = JSON.parse(fs.readFileSync(local, "utf8")).output;
  return { moment: shown.moment, body };
}

/** The moment as one side's extractor sees it now: the kept body, or a fresh extraction from that side's root. */
export async function momentOn(side: { root: string; fresh: boolean }, m: MomentShown, spec: JudgeSpec): Promise<MomentRecord | { error: string }> {
  let raw: unknown = m.body;
  if (side.fresh) {
    const rel = `${MOMENTS_DIR}/${m.moment.kind}.ts`;
    const file = path.join(side.root, rel);
    const header = parseExtractorHeader(fs.readFileSync(file, "utf8"));
    const input = { kind: m.moment.kind, subject: m.moment.subject, at: m.moment.event_at, refs: m.moment.refs ?? {}, events: m.moment.events ?? 1, moment: m.moment.short_id, ...(m.body?.window ? { window: m.body.window } : {}) };
    const out = await runExtractor({ moment: m.moment.short_id, source: String(m.moment.source ?? ""), input, extractor: { path: rel, root: side.root, version: await fileVersion(file), timeout_ms: header.timeout_ms }, storage: "host" });
    if (out.error) return { error: out.error };
    raw = JSON.parse(out.output!);
  }
  if (!raw) return { error: "the moment's body is not kept anywhere this machine can read" };
  return momentForTry(raw, spec, m.moment.subject, Date.now());
}

/** Three-way merge of one file: `theirs`' change from `from` laid onto `mine`. Null when the two edits touch the same lines. */
export function mergeText(mine: string, from: string, theirs: string): string | null {
  if (theirs === from || mine === theirs) return mine;
  if (mine === from) return theirs;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "judge-merge-"));
  try {
    const [a, o, b] = ["mine", "from", "theirs"].map((n) => path.join(tmp, n));
    fs.writeFileSync(a, mine);
    fs.writeFileSync(o, from);
    fs.writeFileSync(b, theirs);
    // Merged in place into `mine`'s file and read back, so the result never depends on a captured pipe.
    const r = spawnSync("git", ["merge-file", "-q", a, o, b], { stdio: "ignore" });
    return r.status === 0 ? fs.readFileSync(a, "utf8") : null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const CLOSED_PROBLEM = new Set(["done", "dropped", "cancelled", "canceled", "archived"]);

/** Every judge and extractor an edit touches, in words: "the comms and match judges' prompts and the match extractor". */
export function partNames(files: string[]): string {
  const judges = [...new Set(files.map((f) => /judges\/([\w-]+)\.md$/.exec(f)?.[1]).filter(Boolean))];
  const kinds = [...new Set(files.map((f) => /moments\/([\w-]+)\.ts$/.exec(f)?.[1]).filter(Boolean))];
  const and = (xs: unknown[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : String(xs[0] ?? ""));
  const words = [
    judges.length ? `the ${and(judges)} judge${judges.length > 1 ? "s' prompts" : "'s prompt"}` : "",
    kinds.length ? `the ${and(kinds)} extractor${kinds.length > 1 ? "s" : ""}` : "",
  ].filter(Boolean);
  return words.length ? words.join(" and ") : "the extractor's helpers";
}

const readOr = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

/** Where a waiting card's measured copy lives: the card says (newer cards), else its newest run directory beside ours whose card is the same. */
function dirOfCard(card: JudgeFixCard & { dir?: string }, near: string): string | null {
  if (card.dir && fs.existsSync(path.join(card.dir, "cases.json"))) return card.dir;
  const parent = path.dirname(near);
  const dirs = fs.existsSync(parent) ? fs.readdirSync(parent).filter((n) => n.startsWith(`${card.problem}-`)).sort().reverse() : [];
  for (const n of dirs) {
    const d = path.join(parent, n);
    try {
      const mine = JSON.parse(fs.readFileSync(path.join(d, "judge-fix.json"), "utf8"));
      if (mine.change === card.change) return d;
    } catch { /* not measured there */ }
  }
  return null;
}

/**
 * Lay every other judge fix waiting for its reviewer in this project that
 * changes what this one's judges see onto this one's base and copy, oldest first, so the edits publish in a line and each is
 * measured on top of the ones before it, never beside them. A waiting fix that
 * is itself built on this problem is left out (it publishes after us). Two
 * edits to the same lines stop here, naming both. Returns the fixes added.
 */
async function stackOnWaiting(deps: PublishDeps, dir: string, cf: CasesFile): Promise<StackedFix[]> {
  // A copy laid out before bases were kept has no base of its own to lay edits onto (its base is the checkout).
  if (!cf.base) return [];
  const scope: Record<string, unknown> = { ...(await scopeFor(deps, undefined, true)) };
  delete scope.project;
  const views: any[] = await apiPost(deps, "/cli/line/trial/cards", { ...scope, project: cf.project_id }, { read: true });
  // Only an edit that changes what this fix's judges see: their prompts, their moments' extractors, the extractors' shared helpers.
  const kinds = cf.judges.map((j) => {
    const f = path.join(cf.root, JUDGES_DIR, `${j}.md`);
    const spec = fs.existsSync(f) ? parseJudgeSpec(j, fs.readFileSync(f, "utf8")) : null;
    return spec && !("error" in spec) ? spec.moment : null;
  });
  const seen = new Set([...cf.judges.map((j) => `${JUDGES_DIR}/${j}.md`), ...kinds.filter(Boolean).map((k) => `${MOMENTS_DIR}/${k}.ts`)]);
  const reaches = (file: string) => seen.has(file) || (file.startsWith(`${MOMENTS_DIR}/`) && file.slice(MOMENTS_DIR.length + 1).includes("/"));
  const waiting = (views ?? [])
    // A card whose problem has closed (fixed some other way, dropped) is not going to publish, nor is one later work
    // superseded (line-versions.md LV1: shown to nobody, asked of nobody): nothing is built on either.
    .filter((v) => v.status === "waiting" && v.judge_fix && !v.superseded && !CLOSED_PROBLEM.has(v.task_status) && v.task_short_id !== cf.task && !(cf.stacked ?? []).some((s) => s.card === v.short_id))
    .filter((v) => (v.judge_fix as JudgeFixCard).diff.some((d) => reaches(d.file)))
    .sort((a, b) => a.created_at - b.created_at);
  const added: StackedFix[] = [];
  // Every merge is made in memory first; nothing is written unless all of them land.
  const writes = new Map<string, string>();
  const current = (file: string) => writes.get(file) ?? readOr(file);
  for (const v of waiting) {
    const card = v.judge_fix as JudgeFixCard & { dir?: string };
    const theirDir = dirOfCard(card, dir);
    if (!theirDir) { console.error(fmt.warning(`${v.short_id} (${v.task_short_id}) waits on ${card.diff.map((d) => d.file).join(", ")} but its measured copy is not on this machine; not built on`)); continue; }
    const theirs: CasesFile = JSON.parse(fs.readFileSync(path.join(theirDir, "cases.json"), "utf8"));
    if ((theirs.stacked ?? []).some((s) => s.problem === cf.task)) continue;
    const theirBase = theirs.base ?? theirs.root;
    const files = card.diff.map((d) => d.file);
    for (const rel of files) {
      const from = readOr(path.join(theirBase, rel));
      const to = readOr(path.join(theirs.arm, rel));
      for (const side of [cf.base, cf.arm]) {
        const merged = mergeText(current(path.join(side, rel)), from, to);
        if (merged === null) fail(`${rel}: ${v.short_id} (${v.task_short_id}) waits with an edit to the same lines this fix needs. Settle ${v.short_id} first (publish or not now), then arm again.`);
        writes.set(path.join(side, rel), merged);
      }
    }
    added.push({ problem: v.task_short_id, card: v.short_id, dir: theirDir, files });
  }
  for (const [file, text] of writes) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  if (added.length) {
    cf.stacked = [...(cf.stacked ?? []), ...added];
    fs.writeFileSync(path.join(dir, "cases.json"), JSON.stringify(cf, null, 2) + "\n");
  }
  return added;
}

type Side = "base" | "arm";
type Specs = Map<string, { base: JudgeSpec; arm: JudgeSpec; briefsBase: ExpectationsBrief[]; briefsArm: ExpectationsBrief[] }>;
type RecordOf = (side: Side, moment: string, judge: string) => Promise<MomentRecord | { error: string }>;

/** Each judge on each side, and the expectations it grades against. */
async function loadSpecs(deps: PublishDeps, cf: CasesFile, baseRoot: string): Promise<Specs> {
  const specs: Specs = new Map();
  for (const name of cf.judges) {
    const read = (root: string) => {
      const s = parseJudgeSpec(name, fs.readFileSync(path.join(root, JUDGES_DIR, `${name}.md`), "utf8"));
      if ("error" in s) fail(`${root}/${JUDGES_DIR}/${name}.md: ${s.error}`);
      return s;
    };
    const base = read(baseRoot);
    const arm = read(cf.arm);
    const briefs = async (spec: JudgeSpec) => {
      const out: ExpectationsBrief[] = [];
      for (const project of spec.projects) {
        const b = await apiPost(deps, "/cli/expectations/brief", await scopeFor(deps, undefined, false, project), { read: true });
        out.push(narrowBrief({ project: b.project.title, version: b.version, text: b.text, ids: b.ids ?? [], ...(b.since ? { since: b.since } : {}) }, spec.parts));
      }
      return out;
    };
    specs.set(name, { base, arm, briefsBase: await briefs(base), briefsArm: await briefs(arm) });
  }
  return specs;
}

/** Each moment as each side's judge reads it (its kept body, or extracted afresh when the edit changed an extractor), loaded once. */
function momentRecords(deps: PublishDeps, scope: Record<string, unknown>, cf: CasesFile, baseRoot: string, fresh: boolean, specs: Specs): RecordOf {
  const shown = new Map<string, Promise<MomentShown>>();
  const records = new Map<string, Promise<MomentRecord | { error: string }>>();
  return (side, moment, judge) => {
    const k = `${side}|${moment}|${judge}`;
    if (!records.has(k)) {
      if (!shown.has(moment)) shown.set(moment, showMoment(deps, scope, moment));
      const s = specs.get(judge)!;
      records.set(k, shown.get(moment)!.then((m) => momentOn({ root: side === "base" ? baseRoot : cf.arm, fresh }, m, side === "base" ? s.base : s.arm)));
    }
    return records.get(k)!;
  };
}

/** The message a quote sits in, as this record shows it: its evidence subject and identity; null when the quote places none. */
function messageIn(record: MomentRecord | { error: string }, quote: string | undefined): string | null {
  if (!quote || "error" in record) return null;
  const message = evidenceMessage(record, quote);
  return message ? `${evidenceSubject(record, quote)}|${message}` : null;
}

/**
 * The team's rulings a judge-fix request carries for one of the ruled cases'
 * own moments: every ruling but those on the ruled messages themselves. Those
 * rulings are the answer the measurement asks the judge for, so a request that
 * carried them would tell both sides the answer and measure nothing about the
 * edit. `messageOf` places a quote in the moment (null when it places none); a
 * ruling whose quote places no message is withheld when its words are a ruled
 * quote's. Controls keep every ruling, as in production.
 */
export function rulingsWithheld<R extends { quote: string }>(rulings: R[], ruledQuotes: string[], messageOf: (quote: string) => string | null): R[] {
  const own = new Set(ruledQuotes.map(messageOf).filter((m): m is string => !!m));
  const words = new Set(ruledQuotes.map((q) => q.trim()));
  return rulings.filter((r) => {
    const at = messageOf(r.quote);
    return at ? !own.has(at) : !words.has(r.quote.trim());
  });
}

/**
 * Held-out cases: live findings of the same judges with the same misreading
 * that nobody ruled on, named in <dir>/held-out.json ([{ finding, why }]).
 * The ruled cases are what the fix was made from; only these show it
 * generalizes. Measured like ruled cases, but their requests keep every
 * ruling, as in production (none is on their own message, or they would be
 * ruled cases).
 */
type HeldOut = { finding: string; why: string; moment: string; expectation: string; judge: string; quote: string };
export function readHeldOut(raw: unknown): Array<{ finding: string; why: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => (typeof x === "string" ? { finding: x, why: "" } : { finding: String(x?.finding ?? ""), why: String(x?.why ?? "") })).filter((x) => /^sg-\d+$/.test(x.finding));
}
async function heldOutCases(deps: PublishDeps, dir: string, ruledFindings: Set<string>): Promise<HeldOut[]> {
  const file = path.join(dir, "held-out.json");
  if (!fs.existsSync(file)) return [];
  const out: HeldOut[] = [];
  for (const h of readHeldOut(JSON.parse(fs.readFileSync(file, "utf8")))) {
    if (ruledFindings.has(h.finding)) fail(`${file}: ${h.finding} is a ruled case, not held out`);
    const shown = await apiPost(deps, "/cli/signal/show", { signal: h.finding }, { read: true });
    const sig = shown.signal ?? shown;
    const judge = String(sig.judge ?? String(sig.source ?? "").replace(/^judge:/, ""));
    if (!sig.moment || !sig.subject || !judge) fail(`${file}: ${h.finding} names no moment, expectation and judge`);
    out.push({ ...h, moment: sig.moment, expectation: sig.subject, judge, quote: quoteOfDetail(sig.detail_md) });
  }
  return out;
}

/** Each ruled moment's quotes (twins included): the messages whose rulings its requests withhold. */
export function ruledQuotesByMoment(cases: Array<{ moment: string; quote?: string }>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of cases) if (c.quote) out.set(c.moment, [...(out.get(c.moment) ?? []), c.quote]);
  return out;
}

/** The ruled cases as distinct messages (ruledByMessage), each placed on what is published now; cases laid out before they carried quotes read them now. */
async function ruledCases(deps: PublishDeps, cf: CasesFile, recordOf: RecordOf) {
  for (const c of cf.cases) {
    if (c.quote !== undefined) continue;
    const shown = await apiPost(deps, "/cli/signal/show", { signal: c.finding }, { read: true });
    c.quote = quoteOfDetail((shown.signal ?? shown).detail_md);
  }
  const placed = new Map<RuledCase, string | null>();
  for (const c of cf.cases) placed.set(c, messageIn(await recordOf("base", c.moment, c.judge), c.quote));
  return ruledByMessage(cf.cases, (c) => placed.get(c) ?? null);
}

/** What the base side's cached runs depend on: its judges' files, the extractor files it re-extracts with (`fresh`), and the expectations it grades against. */
async function baseStamp(cf: CasesFile, baseRoot: string, specs: Specs, fresh: string[], on: JudgeBackend): Promise<string> {
  const files = [...cf.judges.map((j) => `${JUDGES_DIR}/${j}.md`), ...fresh.filter((p) => p.startsWith(MOMENTS_DIR))];
  const versions = Object.fromEntries(await Promise.all(files.map(async (p) => [p, fs.existsSync(path.join(baseRoot, p)) ? (await fileVersion(path.join(baseRoot, p))).slice(0, 10) : "none"])));
  // `rulings` names how the ruled cases' requests treat the team's rulings (rulingsWithheld), so runs made while they carried them are not reused.
  // `on` names where the runs were made, so a side judged on the subscription is never set beside API runs of the other.
  return JSON.stringify({ versions, briefs: [...specs.values()].flatMap((x) => x.briefsBase.map((b) => `${b.project}@${b.version}`)), rulings: "withheld-on-ruled", ...(on === "api" ? {} : { on }) });
}

type Measured = { found: Map<string, RunFound | null>; runs: AbRun[]; spent: number; spentBy: Record<Side, { usd: number; runs: number }>; model: string; stopped: string | null };
const runKey = (side: Side, moment: string, judge: string, rep: number) => `${side}|${moment}|${judge}|${rep}`;

/** Every unit judged `reps` times on each side asked for, on the team's budget; the base side's runs are cached in <dir>/ab-base.jsonl by what they ran. */
async function measure(deps: PublishDeps, scope: Record<string, unknown>, o: { task: string; dir: string; specs: Specs; recordOf: RecordOf; units: Array<{ moment: string; judge: string }>; sides: Side[]; reps: number; budget: number; stamp: string; withhold?: Map<string, string[]>; on: JudgeBackend }): Promise<Measured> {
  const cachePath = path.join(o.dir, "ab-base.jsonl");
  const cache = new Map<string, RunFound>();
  if (fs.existsSync(cachePath)) for (const l of fs.readFileSync(cachePath, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l); cache.set(r.key, readRunFound(r.found)); }
  const out: Measured = { found: new Map(), runs: [], spent: 0, spentBy: { base: { usd: 0, runs: 0 }, arm: { usd: 0, runs: 0 } }, model: "", stopped: null };
  const jobs: Array<{ side: Side; moment: string; judge: string; rep: number }> = [];
  for (const u of new Map(o.units.map((u) => [`${u.moment}|${u.judge}`, u])).values()) {
    for (let rep = 0; rep < o.reps; rep++) for (const side of o.sides) jobs.push({ side, moment: u.moment, judge: u.judge, rep });
  }
  // The team's rulings on the messages each moment shows, as a published judge reads them (momentJudging.rulingsOn); the same on both sides.
  const rulingsOf = new Map<string, Promise<JudgeRuling[]>>();
  // Rulings are the workspace's, not a project's: the read takes the workspace scope alone.
  const { project: _project, ...workspaceScope } = scope;
  const rulingsFor = (moment: string, record: MomentRecord) => {
    if (!rulingsOf.has(moment)) rulingsOf.set(moment, apiPost(deps, "/cli/moments/rulings", { ...workspaceScope, scopes: evidenceScopes(record) }, { read: true })
      .then((all: JudgeRuling[]) => rulingsShown(record, all ?? []))
      .catch(() => []));
    return rulingsOf.get(moment)!;
  };
  const run = async (j: (typeof jobs)[number]) => {
    const key = runKey(j.side, j.moment, j.judge, j.rep);
    const cached = `${o.stamp}|${j.moment}|${j.judge}|${j.rep}`;
    if (j.side === "base" && cache.has(cached)) {
      out.runs.push({ ...j, cached: true, findings: cache.get(cached)! });
      return out.found.set(key, cache.get(cached)!);
    }
    if (out.spent >= o.budget) { out.stopped = `stopped at $${out.spent.toFixed(2)}, the --budget`; return out.found.set(key, null); }
    const s = o.specs.get(j.judge)!;
    const spec = j.side === "base" ? s.base : s.arm;
    const record = await o.recordOf(j.side, j.moment, j.judge);
    if ("error" in record) return out.found.set(key, null);
    // The lines as they stood when the moment happened, as a published judge reads them.
    const briefs = (j.side === "base" ? s.briefsBase : s.briefsArm).map((b) => briefAt(b, record.at ?? record.event_at));
    const shown = await rulingsFor(j.moment, record);
    const ruledQuotes = o.withhold?.get(j.moment);
    const rulings = ruledQuotes ? rulingsWithheld(shown, ruledQuotes, (q) => messageIn(record, q)) : shown;
    const request = judgeRequest(spec, briefs, record, Math.min(Date.now(), record.at ?? Date.now()), rulings);
    out.model = request.model;
    const result = await judgeCall(o.on, deps, scope, request, `Judge A/B ${j.judge} ${o.task}`);
    out.spent += result.cost_usd;
    if (!result.ok) { if (result.reason === "budget") out.stopped = "the team's model budget is full"; return out.found.set(key, null); }
    out.spentBy[j.side].usd += result.cost_usd;
    out.spentBy[j.side].runs++;
    const parsed = parseJudgeReply(result.text, briefs.flatMap((b) => b.ids));
    const found: RunFound | null = parsed ? parsed.findings.map((f) => ({ expectation: f.expectation, quote: f.quote ?? "", what_happened: f.what_happened, severity: f.severity })) : null;
    out.runs.push({ ...j, findings: found });
    out.found.set(key, found);
    if (found && j.side === "base") fs.appendFileSync(cachePath, JSON.stringify({ key: cached, found }) + "\n");
  };
  const queue = [...jobs];
  // A subscription's window is shared with every session on the login, so it takes fewer at once.
  await Promise.all(Array.from({ length: o.on === "subscription" ? 3 : 6 }, async () => { while (queue.length && !out.stopped) await run(queue.shift()!); }));
  return out;
}

/**
 * The findings waiting trial proposals rest on, one per card: its cited case
 * when that is a live finding of these judges, else its problem's newest such
 * finding. The problem being fixed is not one of them: its findings are what
 * the fix is meant to move.
 */
async function restsOf(deps: PublishDeps, scope: Record<string, unknown>, cf: CasesFile, live: any[]): Promise<Array<{ card: string; problem: string; finding: string; moment: string; expectation: string; judge: string }>> {
  const cards: any[] = await apiPost(deps, "/cli/line/trial/cards", { ...scope, limit: 300 }, { read: true }).catch(() => []);
  const out: Array<{ card: string; problem: string; finding: string; moment: string; expectation: string; judge: string }> = [];
  for (const c of cards ?? []) {
    if (c.status !== "waiting" || String(c.project_id) !== String(cf.project_id) || c.task_short_id === cf.task) continue;
    const mine = live.filter((s) => s.task_short_id === c.task_short_id).sort((a, b) => b.created_at - a.created_at);
    const pick = mine.find((s) => s.short_id === c.proposal?.case?.signal) ?? mine[0];
    if (pick) out.push({ card: c.short_id, problem: c.task_short_id, finding: pick.short_id, moment: pick.moment, expectation: pick.subject, judge: pick.judge });
  }
  return out.slice(0, 12);
}

/** A unit's runs on one side that found its expectation at all (a control finding its own line again). */
function countLine(m: Measured, u: { moment: string; judge: string; expectation: string }, side: Side, reps: number) {
  let runs = 0, hits = 0;
  for (let rep = 0; rep < reps; rep++) {
    const f = m.found.get(runKey(side, u.moment, u.judge, rep));
    if (!f) continue;
    runs++;
    if (f.some((x) => x.expectation === u.expectation)) hits++;
  }
  return { runs, hits };
}

/**
 * A ruled case's runs on one side that still file its expectation on its
 * message: a finding of that line on another message of the moment is not the
 * ruled one. A quote this side cannot place counts, so an unplaced reply never
 * reads as a fix.
 */
async function countRuled(m: Measured, recordOf: RecordOf, c: { moment: string; judge: string; expectation: string; quote?: string }, side: Side, reps: number) {
  const record = await recordOf(side, c.moment, c.judge);
  const target = messageIn(record, c.quote);
  let runs = 0, hits = 0;
  for (let rep = 0; rep < reps; rep++) {
    const f = m.found.get(runKey(side, c.moment, c.judge, rep));
    if (!f) continue;
    runs++;
    if (f.some((x) => x.expectation === c.expectation && (!target || !x.quote || [null, target].includes(messageIn(record, x.quote))))) hits++;
  }
  return { runs, hits };
}

/** The published judge files a case again at most once in five runs: a draw it does not repeat, which no fix can separate from. */
export const isDraw = (b: { runs: number; hits: number }) => b.runs > 0 && b.hits * 5 <= b.runs;

/**
 * What the published judge's repeats leave to fix. `draws` when every case ran
 * and what it repeats is too rare to measure a fix against: every case is a
 * draw, or the cases left, pooled as ab pools them, could not separate even
 * from a fix that ended them all (2 of 5 runs, ct-59568). The problem then
 * closes with no fix instead of sending a fixer round three times.
 */
export function repeatsOutcome(cases: Array<{ runs: number; hits: number }>): "draws" | "repeats" {
  if (cases.some((b) => b.runs === 0)) return "repeats";
  const kept = cases.filter((b) => !isDraw(b));
  const runs = kept.reduce((n, b) => n + b.runs, 0);
  const best = fisherOneSided(0, runs, kept.reduce((n, b) => n + b.hits, 0), runs, "less");
  return best !== null && best <= JUDGE_FIX_ALPHA ? "repeats" : "draws";
}

export function registerJudgeFixCommands(judges: Command, deps: PublishDeps): void {
  judges
    .command("arm")
    .description("Lay out a judge-route problem's fix: its cases, and an edited copy of this checkout's .codecast to change")
    .requiredOption("--task <ct>", "The problem whose findings are cases against a judge")
    .option("--dir <dir>", "Where the cases and the edited copy go")
    .option("--under <dir>", "Or a new directory for this run under this one, named for the problem and the time")
    .action(async (options: { task: string; dir?: string; under?: string }) => {
      const root = await repoRoot(process.env.CODECAST_CWD || process.cwd());
      if (!options.dir && !options.under) fail("Give --dir, or --under for a new directory");
      const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
      const dir = path.resolve(options.dir ?? path.join(options.under!, `${options.task}-${stamp}`));
      fs.mkdirSync(dir, { recursive: true });
      const arm = path.join(dir, "arm");
      const { title, project_id, cases } = await readCases(deps, options.task);
      if (!cases.length) fail(`${options.task}'s cases name no moment and expectation to measure on`);
      const base = path.join(dir, "base");
      layOutArm(root, base);
      layOutArm(root, arm);
      const kindOf = (judge: string) => {
        const f = path.join(root, JUDGES_DIR, `${judge}.md`);
        const spec = fs.existsSync(f) ? parseJudgeSpec(judge, fs.readFileSync(f, "utf8")) : null;
        return spec && !("error" in spec) ? spec.moment : null;
      };
      const parts = new Map<string, { against: CaseTarget; name: string; file: string }>();
      for (const c of cases) {
        const p = partFile(c, kindOf);
        if (p) parts.set(p.file, { against: c.against, ...p });
      }
      const out: CasesFile = { task: options.task, title, project_id, judges: [...new Set(cases.map((c) => c.judge))], parts: [...parts.values()], cases, root, base, arm };
      fs.writeFileSync(path.join(dir, "cases.json"), JSON.stringify(out, null, 2) + "\n");
      await stackOnWaiting(deps, dir, out);
      console.log(JSON.stringify({ dir, arm, cases: path.join(dir, "cases.json"), judges: out.judges, parts: out.parts, moments: [...new Set(cases.map((c) => c.moment))], ...(out.stacked?.length ? { builds_on: out.stacked.map((x) => `${x.card} (${x.problem}): ${x.files.join(", ")}`) } : {}) }, null, 2));
    });

  judges
    .command("base")
    .description("Before a judge-route fix is made: judge the ruled cases with what is published, reps times each. A case it files again at most once in five is a draw it does not repeat, which no fix can separate from: draws leave the cases file, and when every case is one the problem needs no fix")
    .requiredOption("--task <ct>", "The problem the cases gather on")
    .requiredOption("--dir <dir>", "The directory `cast line judges arm` laid out")
    .option("--reps <n>", "Judge runs per case", (v: string) => parseInt(v, 10), 5)
    .option("--budget <usd>", "Stop spending past this", (v: string) => Number(v), 3)
    .option("--on <backend>", "Where the judge calls run: api (the team's budget) or subscription (this machine's Claude Code login); default the judges' source's judge_on", judgeBackendOption)
    .option("--json", "Machine-readable output")
    .action(async (options: { task: string; dir: string; reps: number; budget: number; on?: JudgeBackend; json?: boolean }) => {
      const dir = path.resolve(options.dir);
      const file = path.join(dir, "cases.json");
      if (!fs.existsSync(file)) fail(`No ${file}: run cast line judges arm --task ${options.task} --dir ${options.dir} first`);
      const cf: CasesFile = JSON.parse(fs.readFileSync(file, "utf8"));
      process.env.CODECAST_CWD = cf.root;
      const baseRoot = cf.base ?? cf.root;
      const scope = await scopeFor(deps, undefined, false);
      const specs = await loadSpecs(deps, cf, baseRoot);
      const recordOf = momentRecords(deps, scope, cf, baseRoot, false, specs);
      const ruled = await ruledCases(deps, cf, recordOf);
      // The same runs ab's base side reads for a prompt edit, so they are not paid for twice.
      const on = options.on ?? (await judgeBackendOf(deps, scope, cf.judges));
      const m = await measure(deps, { ...scope, project: cf.project_id }, { task: options.task, dir, specs, recordOf, reps: options.reps, budget: options.budget, sides: ["base"], units: ruled, stamp: await baseStamp(cf, baseRoot, specs, [], on), withhold: ruledQuotesByMoment(cf.cases), on });
      const rows = await Promise.all(ruled.map(async (c) => ({ c, b: await countRuled(m, recordOf, c, "base", options.reps) })));
      const ran = rows.filter((r) => r.b.runs > 0);
      const draws = ran.filter((r) => isDraw(r.b));
      const runs = ran.reduce((n, r) => n + r.b.runs, 0);
      const hits = ran.reduce((n, r) => n + r.b.hits, 0);
      const each = rows.map((r) => `${r.c.moment}${r.c.twins.length ? `+${r.c.twins.length}` : ""} ${r.c.expectation.replace(/^ex-[\w-]*?-(\d+)$/, "ex-$1")} ${r.b.hits}/${r.b.runs}`).join(", ");
      const outcome = repeatsOutcome(rows.map((r) => r.b));
      const left = new Set(draws.flatMap((r) => [`${r.c.moment}|${r.c.finding}`, ...r.c.twins.map((t) => `${t.moment}|${t.finding}`)]));
      if (outcome === "repeats" && draws.length) {
        cf.cases = cf.cases.filter((c) => !left.has(`${c.moment}|${c.finding}`));
        fs.writeFileSync(file, JSON.stringify({ ...cf, draws: draws.map((r) => ({ finding: r.c.finding, moment: r.c.moment, expectation: r.c.expectation, base: r.b.hits, runs: r.b.runs })) }, null, 2) + "\n");
      }
      // Plain words a station passes on in a shell string: no quotes, no $.
      const evidence = (outcome === "draws"
        ? `The published judge files the ruled findings again ${hits} of ${runs} runs (${each}): too rarely for a fix to be measured against them in ${options.reps} runs each. Closed with no fix.`
        : draws.length
          ? `The published judge repeats ${ran.length - draws.length} of ${rows.length} ruled cases (${each}); ${draws.length} at most 1 in 5 left out as draws.`
          : `The published judge repeats the ruled cases ${hits} of ${runs} runs (${each}).`).replace(/["'`$\\]/g, "");
      const out = { outcome, evidence, cost_usd: Math.round(m.spent * 100) / 100, cases: rows.map((r) => ({ finding: r.c.finding, moment: r.c.moment, twins: r.c.twins.map((t) => t.moment), expectation: r.c.expectation, base: r.b.hits, runs: r.b.runs, draw: isDraw(r.b) })), ...(m.stopped ? { stopped: m.stopped } : {}) };
      if (options.json) console.log(JSON.stringify(out, null, 2));
      else {
        console.log(`${options.task}: ${outcome}  ($${out.cost_usd.toFixed(2)})`);
        for (const c of out.cases) console.log(`  ${c.moment}${c.twins.length ? ` (+${c.twins.join(", ")})` : ""} ${c.expectation}: ${c.base}/${c.runs}${c.draw ? "  draw" : ""}`);
        console.log(`  ${evidence}`);
      }
    });

  judges
    .command("ab")
    .description("Measure a judge-route fix: the edited copy against what is published, on the ruled moments and on live findings it must keep; writes the reviewer's card")
    .requiredOption("--task <ct>", "The problem the fix is for")
    .requiredOption("--dir <dir>", "The directory `cast line judges arm` laid out")
    .option("--change <sentence>", "What the edit makes the judge do, one sentence (the card's words); default <dir>/change.txt")
    .option("--reps <n>", "Judge runs per moment on each side", (v: string) => parseInt(v, 10), 5)
    .option("--controls <n>", "Live findings of the same judges to keep (distinct moments)", (v: string) => parseInt(v, 10), 10)
    .option("--budget <usd>", "Stop spending past this", (v: string) => Number(v), 8)
    .option("--on <backend>", "Where the judge calls run: api (the team's budget) or subscription (this machine's Claude Code login); default the judges' source's judge_on", judgeBackendOption)
    .option("--json", "Machine-readable output")
    .action(async (options: { task: string; dir: string; change?: string; reps: number; controls: number; budget: number; on?: JudgeBackend; json?: boolean }) => {
      const dir = path.resolve(options.dir);
      const file = path.join(dir, "cases.json");
      if (!fs.existsSync(file)) fail(`No ${file}: run cast line judges arm --task ${options.task} --dir ${options.dir} first`);
      const cf: CasesFile = JSON.parse(fs.readFileSync(file, "utf8"));
      const changeFile = path.join(dir, "change.txt");
      const changeWords = options.change?.trim() || (fs.existsSync(changeFile) ? fs.readFileSync(changeFile, "utf8").trim() : "");
      if (!changeWords) fail(`Say what the edit does: --change "<sentence>" or ${changeFile}`);
      // The checkout's line profile names the workspace, wherever in it the station runs.
      process.env.CODECAST_CWD = cf.root;
      // A fix that came to wait while this one was being made is built on now, so the two never publish beside each other.
      {
        const late = await stackOnWaiting(deps, dir, cf);
        for (const x of late) console.error(fmt.warning(`built on ${x.card} (${x.problem}), which came to wait on ${x.files.join(", ")} while this fix was made`));
      }
      const baseRoot = cf.base ?? cf.root;
      const changed = [...changedFiles(baseRoot, cf.arm, JUDGES_DIR), ...changedFiles(baseRoot, cf.arm, MOMENTS_DIR)];
      if (!changed.length) fail(`Nothing in ${cf.arm}/.codecast differs from the checkout: edit the copy first`);
      const extractorChanged = changed.some((p) => p.startsWith(MOMENTS_DIR));
      const scope = await scopeFor(deps, undefined, false);

      const specs = await loadSpecs(deps, cf, baseRoot);
      const recordOf = momentRecords(deps, scope, cf, baseRoot, extractorChanged, specs);

      // The ruled cases as distinct messages, and controls: live findings of the same judges, the ruled expectations first.
      const ruled = await ruledCases(deps, cf, recordOf);
      const held = await heldOutCases(deps, dir, new Set(cf.cases.map((c) => c.finding)));
      for (const h of held) if (!specs.has(h.judge)) fail(`held-out ${h.finding} is the ${h.judge} judge's, not one of this problem's (${cf.judges.join(", ")})`);
      const ruledMoments = new Set([...cf.cases.map((c) => c.moment), ...held.map((h) => h.moment)]);
      const ruledExp = new Set(ruled.map((c) => c.expectation));
      const live: any[] = [];
      for (const name of cf.judges) {
        // Asked for by project: the newest 400 of a judge's findings team-wide can hold almost none of this project's.
        const r = await apiPost(deps, "/cli/signal/ls", { ...scope, project: cf.project_id, source: `judge:${name}`, limit: 400 }, { read: true });
        live.push(...(r.signals ?? []).filter((s: any) => s.project_id === cf.project_id && !s.retired && s.moment && !ruledMoments.has(s.moment)));
      }
      live.sort((a, b) => Number(ruledExp.has(b.subject)) - Number(ruledExp.has(a.subject)) || b.created_at - a.created_at);
      const controls: Array<{ moment: string; expectation: string; judge: string; finding: string }> = [];
      const seen = new Set<string>();
      for (const s of live) {
        if (controls.length >= options.controls || seen.has(s.moment)) continue;
        seen.add(s.moment);
        controls.push({ moment: s.moment, expectation: s.subject, judge: s.judge, finding: s.short_id });
      }

      // What waiting proposals rest on, by name: a fix that stops finding one empties that proposal (tc-44).
      const rests = await restsOf(deps, scope, cf, live);

      const on = options.on ?? (await judgeBackendOf(deps, scope, cf.judges));
      const m = await measure(deps, { ...scope, project: cf.project_id }, {
        task: options.task, dir, specs, recordOf, reps: options.reps, budget: options.budget, sides: ["base", "arm"],
        units: [...ruled, ...held, ...controls, ...rests], stamp: await baseStamp(cf, baseRoot, specs, extractorChanged ? changed : [], on), withhold: ruledQuotesByMoment(cf.cases), on,
      });
      const { spent, spentBy, model, stopped } = m;

      // Rates: a run of a ruled case counts when it still files the ruled expectation on the ruled message; a control's, when it finds its own again.
      const ruledCount = await Promise.all(ruled.map(async (c) => ({ base: await countRuled(m, recordOf, c, "base", options.reps), arm: await countRuled(m, recordOf, c, "arm", options.reps) })));
      const heldCount = await Promise.all(held.map(async (c) => ({ base: await countRuled(m, recordOf, c, "base", options.reps), arm: await countRuled(m, recordOf, c, "arm", options.reps) })));
      const controlCount = controls.map((c) => ({ base: countLine(m, c, "base", options.reps), arm: countLine(m, c, "arm", options.reps) }));
      const tally = (rows: Array<{ base: { runs: number; hits: number }; arm: { runs: number; hits: number } }>) => {
        let runs = 0, base = 0, arm = 0;
        for (const r of rows) {
          const n = Math.min(r.arm.runs, r.base.runs);
          runs += n;
          base += Math.min(r.base.hits, n);
          arm += Math.min(r.arm.hits, n);
        }
        return { runs, base, arm };
      };
      const r = tally(ruledCount);
      const k = tally(controlCount);
      const ruledG = { ...judgeFixGroup(new Set(ruled.flatMap((c) => [c.moment, ...c.twins.map((t) => t.moment)])).size, r.runs, r.base, r.arm, "fewer"), messages: ruled.length };
      const controlsG = judgeFixGroup(controls.length, k.runs, k.base, k.arm, "more");
      const h = tally(heldCount);
      const heldOut: JudgeFixCard["ab"]["held_out"] = held.length ? {
        ...judgeFixGroup(new Set(held.map((x) => x.moment)).size, h.runs, h.base, h.arm, "fewer"),
        cases: held.map((x, i) => { const { base: b, arm: a } = heldCount[i]!; const n = Math.min(a.runs, b.runs); return { finding: x.finding, moment: x.moment, expectation: x.expectation, judge: x.judge, why: x.why, base: Math.min(b.hits, n), arm: Math.min(a.hits, n), reps: n }; }),
      } : undefined;
      const restRows: JudgeFixRest[] = rests.map((r) => {
        const b = countLine(m, r, "base", options.reps);
        const a = countLine(m, r, "arm", options.reps);
        const n = Math.min(a.runs, b.runs);
        return { card: r.card, problem: r.problem, finding: r.finding, moment: r.moment, expectation: r.expectation, base: Math.min(b.hits, n), arm: Math.min(a.hits, n), reps: n };
      });
      const verdict = judgeFixVerdict(ruledG, controlsG, restRows);
      // What each run said and what each side's judge read, kept beside the card for the reviewer's page.
      fs.writeFileSync(path.join(dir, "ab-runs.jsonl"), abRunLines(m.runs));
      const momentsDir = path.join(dir, "ab-moments");
      fs.rmSync(momentsDir, { recursive: true, force: true });
      fs.mkdirSync(momentsDir, { recursive: true });
      for (const u of new Map([...ruled, ...held, ...controls, ...rests].map((u) => [`${u.moment}|${u.judge}`, u])).values()) {
        for (const side of ["base", "arm"] as const) {
          const record = await recordOf(side, u.moment, u.judge);
          fs.writeFileSync(path.join(momentsDir, `${u.moment}.${u.judge}.${side}.json`), JSON.stringify(record, null, 1) + "\n");
        }
      }
      const kept: JudgeFixKept[] = controls.map((c, i) => {
        const { base: b, arm: a } = controlCount[i]!;
        const n = Math.min(a.runs, b.runs);
        return { finding: c.finding, moment: c.moment, expectation: c.expectation, judge: c.judge, base: Math.min(b.hits, n), arm: Math.min(a.hits, n), reps: n };
      });
      const cases: JudgeFixCase[] = ruled.slice(0, 12).map((c, i) => {
        const { base: b, arm: a } = ruledCount[i]!;
        return { finding: c.finding, moment: c.moment, expectation: c.expectation, said: c.said, correct: c.correct, base: b.hits, arm: a.hits, reps: Math.min(a.runs, b.runs), ...(c.twins.length ? { twins: c.twins } : {}) };
      });
      const diff = changed.map((p) => ({ file: p, ...lineDiff(fs.existsSync(path.join(baseRoot, p)) ? fs.readFileSync(path.join(baseRoot, p), "utf8") : "", fs.readFileSync(path.join(cf.arm, p), "utf8")) }));
      const editedPart = cf.parts.find((p) => changed.includes(p.file)) ?? { against: (extractorChanged ? "extractor" : "judge") as CaseTarget, name: changed[0], file: changed[0] };
      const card: JudgeFixCard = {
        kind: "judge_fix",
        problem: cf.task,
        question: `Publish this change to ${partNames(changed)}?`,
        change: changeWords,
        part: editedPart,
        diff,
        ab: {
          reps: options.reps, model, cost_usd: Math.round(spent * 100) / 100, ruled: ruledG, controls: controlsG, verdict,
          // What one judge run costs on each side (the edit can grow what the judge reads); the base side counts only runs made now, not cached ones.
          ...(restRows.length ? { rests: restRows } : {}),
          kept,
          ...(heldOut ? { held_out: heldOut } : {}),
          rulings: "withheld_on_ruled",
          ...(spentBy.base.runs && spentBy.arm.runs ? { usd_per_run: { base: Math.round((spentBy.base.usd / spentBy.base.runs) * 10000) / 10000, arm: Math.round((spentBy.arm.usd / spentBy.arm.runs) * 10000) / 10000 } } : {}),
        },
        cases,
        dir,
        ...(cf.stacked?.length ? { builds_on: cf.stacked.map((x) => ({ card: x.card, problem: x.problem, files: x.files })) } : {}),
      };
      const checked = validateJudgeFixCard(card);
      if (!checked.ok) fail(`The card is not ready:\n  ${checked.errors.join("\n  ")}`);
      fs.writeFileSync(path.join(dir, "judge-fix.json"), JSON.stringify(card, null, 2) + "\n");
      const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "-");
      if (options.json) console.log(JSON.stringify({ card: path.join(dir, "judge-fix.json"), question: card.question, verdict, ruled: ruledG, controls: controlsG, cost_usd: card.ab.cost_usd, ...(stopped ? { stopped } : {}) }, null, 2));
      else {
        console.log(`${cf.task}: ${verdict.replace("_", " ")}  ($${card.ab.cost_usd.toFixed(2)}, ${options.reps} reps, ${model})`);
        console.log(`  ruled     ${ruledG.messages} messages on ${ruledG.moments} moments: still found ${ruledG.base}/${ruledG.runs} (${pct(ruledG.base, ruledG.runs)}) -> ${ruledG.arm}/${ruledG.runs} (${pct(ruledG.arm, ruledG.runs)})${ruledG.p !== null ? `  p=${ruledG.p.toFixed(4)}` : ""}`);
        console.log(`  controls  ${controlsG.moments} moments: found ${controlsG.base}/${controlsG.runs} (${pct(controlsG.base, controlsG.runs)}) -> ${controlsG.arm}/${controlsG.runs} (${pct(controlsG.arm, controlsG.runs)})`);
        for (const c of cases) console.log(`    ${c.moment}${c.twins?.length ? ` (+${c.twins.map((t) => t.moment).join(", ")})` : ""} ${c.expectation}: ${c.base}/${c.reps} -> ${c.arm}/${c.reps}${caseMoved(c) ? "" : "  not moved"}`);
        if (restRows.length) console.log(`  waiting proposals rest on`);
        for (const r of restRows) console.log(`    ${r.card} (${r.problem}) ${r.finding} on ${r.moment}: ${r.base}/${r.reps} -> ${r.arm}/${r.reps}${restEmptied(r) ? "  EMPTIED" : ""}`);
        if (stopped) console.log(fmt.warning(`  ${stopped}`));
        console.log(`  card: ${path.join(dir, "judge-fix.json")}`);
      }
      // few_controls goes on to the card (held on /trial until a rerun has the controls): the edit is not what is missing, so it never goes back to the fixer.
      process.exit(verdict === "better" || verdict === "few_controls" ? 0 : 1);
    });
}
