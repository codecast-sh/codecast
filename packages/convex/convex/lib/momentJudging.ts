// Judging a moment (docs/architecture/learning-loop.md LL8, LL11): every judge
// of the moment's kind reads it, its reply is recorded on a judge_runs row,
// and a live judge's findings file through the signal door. moments.ts owns
// the moment's life (intake, claims, hand back, reads) and calls in here.

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { sourceFilingScope } from "./ingestScope";
import { sha256Hex } from "./hash";
import { runModelCall, type CallScope } from "../modelCalls";
import type { ModelCallResult, ModelCallSpec } from "@codecast/shared/contracts/modelCall";
import { reembedFinding } from "../findingGroups";
import { newOnResample, type Ruling } from "../judgeRetire";
import type { MomentRecord, MomentWindow } from "@codecast/shared/contracts/moments";
import { briefAt, evidenceMessage, evidenceScopes, evidenceSubject, findingKey, findingKeyScope, findingSignal, judgeRequest, parseJudgeReply, quotesShareMessage, rulingsShown, type ExpectationsBrief, type JudgeFinding, type JudgeHandoff, type JudgeRuling, type JudgeSpec } from "@codecast/shared/contracts/judges";

/** A moment being judged: its row, its source, the judges of its kind. */
export type Finishing = {
  moment: Doc<"moments">;
  source: Doc<"event_sources">;
  judges: Doc<"judges">[];
  /** What is new in the moment, to its newest event; the facts' read time may extend it. */
  window: MomentWindow;
};

export type JudgeOutcome = { judge: string; status: "ok" | "failed" | "skipped" | "queued"; findings: number; filed: number; reason?: string; cost_usd: number };

const refUrl = (m: MomentRecord) => m.refs.find((r) => r.url)?.url;

/**
 * What a judge reads in a moment, as two hashes: the messages (who said what,
 * when; not their delivery state) and the facts and text blocks an extractor
 * computes. A re-read whose messages match read the same conversation, so a
 * finding it misses was missed by a resample, not by news (judgeRetire.settleRun).
 */
export async function judgeInputsOf(record: Pick<MomentRecord, "blocks">): Promise<{ messages: string; facts: string }> {
  const messages = record.blocks.filter((b) => b.type === "message").map((b) => b.type === "message" && [b.direction, b.channel, b.at, b.sender ?? "", b.body]);
  const facts = record.blocks.filter((b) => b.type !== "message");
  return { messages: (await sha256Hex(JSON.stringify(messages))).slice(0, 16), facts: (await sha256Hex(JSON.stringify(facts))).slice(0, 16) };
}

/**
 * Every judge of the moment's kind reads it (LL8), one call each. A shadow
 * judge's findings stay on its run; a live judge's also file, each into the
 * project holding the expectation it cites, as the person who set the source
 * up (the way promoted signals file, X6).
 *
 * Where the call runs is the source's judge_on. On api (the default) it runs
 * here, inside the team's budget. On subscription nothing is sent from here:
 * judgeMoment answers with the requests (JudgeHandoff), the machine that
 * handed the moment in runs each on its Claude Code login, and
 * `/cli/moments/judged` brings the replies back to settleJudge, the same
 * recorder an API reply goes through.
 *
 * An agent judge makes no call here at all: its review of the moment is
 * queued (agentReviews.ts) for a machine running reviews to claim.
 */
export async function judgeMoment(ctx: any, f: Finishing, record: MomentRecord, only?: string[]): Promise<{ judged: JudgeOutcome[]; handoff?: JudgeHandoff }> {
  const reading = await readingOf(ctx, f, record, only);
  const judged: JudgeOutcome[] = [];
  const requests: JudgeHandoff["requests"] = [];
  const here = (f.source.config?.judge_on ?? "api") === "api";
  for (const judge of f.judges) {
    if (judge.agent) {
      const q: { review: string } = await ctx.runMutation(internal.agentReviews.enqueue, { moment_id: f.moment._id, judge_id: judge._id });
      judged.push({ judge: judge.name, status: "queued", findings: 0, filed: 0, reason: q.review, cost_usd: 0 });
      continue;
    }
    const p = await prepareJudge(ctx, f, record, judge, reading);
    if ("outcome" in p) { judged.push(p.outcome); continue; }
    if (!here) { requests.push({ judge: judge.name, request: p.request }); continue; }
    // Charged to the projects whose expectations it grades.
    const result = await runModelCall(ctx, { ...p.where, project_ids: judge.project_ids }, "judge", p.request, `Judge ${judge.name}`);
    judged.push(await settleJudge(ctx, f, record, p, result, reading));
  }
  if (here || !requests.length) return { judged };
  return { judged, handoff: { moment: f.moment.short_id, clock: reading.clock, record, ...(only?.length ? { lines: only } : {}), requests } };
}

/** What every judge of one reading shares: the team's rulings on its messages, its input hashes, the clock, the lines it is scoped to. */
export type Reading = { rulings: JudgeRuling[]; inputs: { messages: string; facts: string }; clock: number; scoped: Set<string> | null };
export async function readingOf(ctx: any, f: Finishing, record: MomentRecord, only?: string[], clock?: number): Promise<Reading> {
  return {
    rulings: await rulingsOn(ctx, f.moment.workspace, record),
    inputs: await judgeInputsOf(record),
    // The judge's clock is the time the facts describe: now for a live read, the as-of time for a replay.
    clock: clock ?? Math.min(Date.now(), record.at ?? Date.now()),
    scoped: only?.length ? new Set(only) : null,
  };
}

/** One judge's call on a moment, ready to send; or the run it skipped, already recorded. */
export type Prepared = {
  judge: Doc<"judges">;
  briefs: Array<ExpectationsBrief & { project_id: Id<"projects">; later: string[] }>;
  ids: string[];
  request: ModelCallSpec;
  where: { workspace: string; team_id?: Id<"teams"> };
  base: Record<string, unknown>;
};
export async function prepareJudge(ctx: any, f: Finishing, record: MomentRecord, judge: Doc<"judges">, reading: Reading): Promise<Prepared | { outcome: JudgeOutcome }> {
  const where = { workspace: f.moment.workspace, ...(f.moment.team_id ? { team_id: f.moment.team_id } : {}) };
  // The lines as they stood at the time the facts describe (the judge's clock): one that came into force later is not graded here.
  const current: Array<ExpectationsBrief & { project_id: Id<"projects"> }> = await ctx.runQuery(internal.moments.briefsFor, { project_ids: judge.project_ids, ...(judge.parts?.length ? { parts: judge.parts } : {}) });
  const briefs = current.map((b) => briefAt(b, record.at ?? record.event_at));
  const expectations = briefs.map((b) => ({ project_id: b.project_id, version: b.version }));
  const base = { judge_id: judge._id, moment_id: f.moment._id, expectations, model: judge.model, inputs: reading.inputs, ...(reading.scoped ? { lines: [...reading.scoped] } : {}) };
  const ids = briefs.flatMap((b) => b.ids);
  if (!ids.length) {
    const reason = "its projects have no expectations to grade against yet";
    await ctx.runMutation(internal.moments.recordRun, { ...base, status: "skipped", reason, findings: 0, cost_usd: 0 });
    return { outcome: { judge: judge.name, status: "skipped", findings: 0, filed: 0, reason, cost_usd: 0 } };
  }
  const spec: JudgeSpec = { name: judge.name, moment: judge.moment_kind, model: judge.model, max_tokens: judge.max_tokens, projects: judge.projects, mode: judge.mode, prompt: judge.prompt };
  return { judge, briefs, ids, request: judgeRequest(spec, briefs, record, reading.clock, reading.rulings), where, base };
}

/** A judge's reply, from the API or a subscription, recorded: a failure as a failed run, an answer parsed, filed when the judge is live, and kept on its run. */
export async function settleJudge(ctx: any, f: Finishing, record: MomentRecord, p: Prepared, result: ModelCallResult, reading: Reading, backend?: "subscription"): Promise<JudgeOutcome> {
  const { judge, briefs, ids, where } = p;
  const base = { ...p.base, ...(backend ? { backend } : {}) };
  const later = briefs.flatMap((b) => b.later);
  const scoped = reading.scoped;
  // A re-read scoped to some lines (`--lines`): the judge still reads every line, as it does live, but files and lets go only under those.
  const inScope = (line: string) => !scoped || scoped.has(line);
  if (!result.ok) {
    const status = result.reason === "budget" ? "skipped" : "failed";
    await ctx.runMutation(internal.moments.recordRun, { ...base, status, reason: result.error, findings: 0, cost_usd: result.cost_usd });
    return { judge: judge.name, status, findings: 0, filed: 0, reason: result.error, cost_usd: result.cost_usd };
  }
  const parsed = parseJudgeReply(result.text, ids);
  if (!parsed) {
    const reason = "the answer held no deviations list";
    await ctx.runMutation(internal.moments.recordRun, { ...base, status: "failed", reason, findings: 0, cost_usd: result.cost_usd });
    return { judge: judge.name, status: "failed", findings: 0, filed: 0, reason, cost_usd: result.cost_usd };
  }
  const startedAt = Date.now();
  const filedNow = judge.mode === "live" ? await fileFindings(ctx, f, judge, briefs, parsed.findings.filter((x) => inScope(x.expectation)), record, where, { messages: reading.inputs.messages, fresh: scoped }) : { ids: [], keys: [], held: [], waiting: [] };
  const signalIds = filedNow.ids;
  // Judged again: this moment now stands behind what the run filed or found again, and no longer behind
  // what it filed before and did not find now, which leaves its problems once no moment stands behind it.
  if (judge.mode === "live") {
    await ctx.runMutation(internal.judgeRetire.settleRun, { moment_id: f.moment._id, moment: f.moment.short_id, judge: judge.name, judge_version: judge.version, held: [...signalIds, ...filedNow.held], keep: filedNow.keys, shown: ids.filter(inScope), ...(later.some(inScope) ? { later: later.filter(inScope) } : {}), inputs: reading.inputs, ...(scoped ? { fresh: [...scoped] } : {}), before: startedAt, actor: f.source.owner_user_id });
  }
  await ctx.runMutation(internal.moments.recordRun, {
    ...base,
    status: "ok",
    findings_json: JSON.stringify(parsed.findings),
    findings: parsed.findings.length,
    ...(parsed.uncited ? { uncited: parsed.uncited } : {}),
    ...(signalIds.length ? { signal_ids: signalIds } : {}),
    ...(filedNow.held.length ? { held_ids: filedNow.held } : {}),
    ...(filedNow.waiting.length ? { waiting: filedNow.waiting } : {}),
    cost_usd: result.cost_usd,
  });
  return { judge: judge.name, status: "ok", findings: parsed.findings.length, filed: signalIds.length, cost_usd: result.cost_usd };
}

/**
 * The team's rulings on messages this moment shows, under any line (LL11): a
 * ruling belongs to the message, so a judge reading that message against
 * another line reads the ruling with it. Only rulings with words.
 */
async function rulingsOn(ctx: any, workspace: string, record: MomentRecord): Promise<JudgeRuling[]> {
  const all: Ruling[] = await ctx.runQuery(internal.judgeRetire.rulings, { workspace, scopes: evidenceScopes(record) });
  return rulingsShown(record, all);
}

// A finding whose evidence (who, expectation, quote) is already filed is the
// same message read again, in a later moment of the conversation or in a
// moment of another kind that shows it (a match holding a party's email): it
// files no second report (findingSignal). When the earlier report is this
// judge's from an earlier version, it takes this run's words and is embedded
// again, so the board and grouping read the way the current judge writes
// (judgeRetire.refound). A finding on a message a ruling already marked wrong
// under the same expectation, from any judge or moment, files nothing
// (judgeRetire.rulings, retireRuled). A finding only this read made, where the
// same judge version read the same messages before, waits for a second read
// to make it too (judgeRetire.newOnResample).
async function fileFindings(ctx: any, f: Finishing, judge: Doc<"judges">, briefs: Array<ExpectationsBrief & { project_id: Id<"projects"> }>, findings: JudgeFinding[], record: MomentRecord, scope: CallScope, read: { messages: string; fresh: Set<string> | null }): Promise<{ ids: Id<"signals">[]; keys: string[]; held: Id<"signals">[]; waiting: string[] }> {
  const ids: Id<"signals">[] = [];
  const originOf = (finding: JudgeFinding) => ({ judge: judge.name, judge_version: judge.version, moment: f.moment.short_id, subject: evidenceSubject(record, finding.quote), message: evidenceMessage(record, finding.quote) });
  const origins = findings.map(originOf);
  const keys = findings.map((finding, i) => findingKey(finding, origins[i]!));
  // The first finding of a key in this reply speaks for it.
  const first = new Map<string, number>();
  keys.forEach((key, i) => first.has(key) || first.set(key, i));
  // A ruling marked this message wrong under this expectation: the finding is
  // that known error again, so it files nothing and its live copies leave.
  const rulings: Ruling[] = await ctx.runQuery(internal.judgeRetire.rulings, { workspace: f.moment.workspace, scopes: [...first.keys()].map(findingKeyScope) });
  const bound = new Map<string, string>();
  for (const [key, i] of first) {
    const scope = findingKeyScope(key);
    const ruling = rulings.find((r) => r.key === key) ?? rulings.find((r) => scope !== key && findingKeyScope(r.key) === scope && quotesShareMessage(record, r.quote, findings[i]!.quote));
    if (ruling) bound.set(key, ruling.short_id);
  }
  if (bound.size) {
    await ctx.runMutation(internal.judgeRetire.retireRuled, { workspace: f.moment.workspace, bound: [...bound].map(([key, ruling]) => ({ key, ruling })), actor: f.source.owner_user_id });
    for (const key of bound.keys()) first.delete(key);
  }
  const signals = new Map([...first].map(([key, i]) => [key, findingSignal(findings[i]!, origins[i]!, refUrl(record))]));
  // A finding this judge version's earlier reads of the same messages did not make is one sample (judgeRetire.newOnResample),
  // unless the re-read was scoped to its line: its facts changed, so this is the judge's first answer on them.
  const lines = [...new Set([...first.values()].map((i) => findings[i]!.expectation))].flatMap((id) => { const project_id = briefs.find((b) => b.ids.includes(id))?.project_id; return project_id ? [{ id, project_id }] : []; });
  const prior: { reads: Array<{ at: number; findings: JudgeFinding[] }>; changed: Record<string, number> } = first.size
    ? await ctx.runQuery(internal.judgeRetire.sameReads, { moment_id: f.moment._id, judge: judge.name, judge_version: judge.version, messages: read.messages, lines })
    : { reads: [], changed: {} };
  const found = prior.reads.map((r) => ({ at: r.at, keys: new Set(r.findings.map((x) => findingKey(x, originOf(x)))) }));
  const once = [...first].filter(([key, i]) => {
    const line = findings[i]!.expectation;
    return !read.fresh?.has(line) && newOnResample(found.filter((r) => r.at > (prior.changed[line] ?? 0)).map((r) => r.keys.has(key)));
  }).map(([key]) => key);
  const again: { live: string[]; updated: Array<{ signal_id: Id<"signals">; key: string }>; held: Id<"signals">[]; waiting?: string[] } = await ctx.runMutation(internal.judgeRetire.refound, {
    workspace: f.moment.workspace,
    judge: judge.name,
    judge_version: judge.version,
    ...(once.length ? { once } : {}),
    rows: [...signals].map(([key, s]) => ({ key, title: s.title, ...(s.detail_md ? { detail_md: s.detail_md } : {}), ...(typeof s.severity === "number" ? { severity: s.severity } : {}) })),
  });
  for (const u of again.updated) {
    ids.push(u.signal_id);
    const s = signals.get(u.key)!;
    await reembedFinding(ctx, scope, { signal_id: u.signal_id, subject: s.subject, text: s.similar_text });
  }
  const filed = new Set([...again.live, ...(again.waiting ?? [])]);
  for (const [key, i] of first) {
    if (filed.has(key)) continue;
    const finding = findings[i]!;
    const project = briefs.find((b) => b.ids.includes(finding.expectation))?.project_id;
    try {
      const result = await ctx.runAction(internal.signals.ingestAs, {
        user_id: f.source.owner_user_id,
        ...signals.get(key)!,
        observed_at: record.at ?? record.event_at,
        ...sourceFilingScope(f.source),
        ...(project ? { project: String(project) } : {}),
      });
      ids.push(result.signal_id);
    } catch (error) {
      console.error(`Judge ${judge.name} on ${f.moment.short_id}: filing a finding failed`, error);
    }
  }
  return { ids, keys, held: again.held, waiting: again.waiting ?? [] };
}
