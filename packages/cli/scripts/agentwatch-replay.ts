#!/usr/bin/env bun
// Replays Union's AgentWatch history into codecast as moments
// (docs/architecture/learning-loop.md LL5, LL7; plan pl-882). It reads, from
// Union's read-only database, the contacts AgentWatch judged, newest first,
// and posts one moment event per AgentWatch judgment (comms on the contact,
// match on the match, call on the call) through a source's ingest door,
// stamped at the time AgentWatch read the evidence, with refs.as_of set to
// that time so the extractor rebuilds the conversation as it stood then.
// Events coalesce by their own times (moments.ts recordMomentEvents), so two
// judgments inside one quiet window become one moment, as they would live.
//
// It writes nothing to Union. What it sent lands in --dir, which the
// clustering and agreement checks join on:
//   window.json   the frozen window (since, until) every later run reuses
//   sent.jsonl    one line per AgentWatch judgment sent: the event, the
//                 moment it lands on (moment_key, moment_event_at), and
//                 AgentWatch's own scores, deviations and findings with their
//                 cluster and cause ids
//   clusters.json AgentWatch's clusters those findings sit in
//   contacts.jsonl the contacts replayed, one line each, in the order taken
//   runs.jsonl    one line per run
//
// Idempotent: a judgment already in sent.jsonl is never sent again, and a
// contact already in contacts.jsonl is not taken again, so a run takes the
// next --contacts contacts in the frozen window. An event posted but not yet
// recorded (a crash between the two) is sent again on the next run and joins
// the same moment, which counts one more event and opens nothing.
//
//   bun packages/cli/scripts/agentwatch-replay.ts --source <trial source> --contacts 20 \
//     [--dir <state dir>] [--since 14d] [--until <iso>] [--per-contact <n>] \
//     [--judges comms,match,call] [--kinds comms=contact-conversation,match=match,call=call] \
//     [--key <ingest key> | $CODECAST_INGEST_KEY] [--batch 200] [--union ~/src/union-mobile] [--dry]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { DEFAULT_QUIET_MS, parseExtractorHeader } from "@codecast/shared/contracts/moments";
import { INGEST_LIMITS } from "@codecast/shared/contracts/ingest";

const { values: a } = parseArgs({
  options: {
    source: { type: "string" },
    contacts: { type: "string" },
    dir: { type: "string", default: path.join(os.homedir(), ".local/share/codecast/flowfactory/trial/replay") },
    since: { type: "string", default: "14d" },
    until: { type: "string" },
    "per-contact": { type: "string" },
    judges: { type: "string", default: "comms,match,call" },
    kinds: { type: "string", default: "comms=contact-conversation,match=match,call=call" },
    key: { type: "string" },
    site: { type: "string" },
    batch: { type: "string", default: "200" },
    union: { type: "string", default: path.join(os.homedir(), "src/union-mobile") },
    dry: { type: "boolean", default: false },
  },
});
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(2);
};
if (!a.source) fail("--source <name> is required: the trial's keyed source the moments go to");
const contactsWanted = Number(a.contacts);
if (!Number.isInteger(contactsWanted) || contactsWanted < 1) fail("--contacts <n> is required: how many new contacts this run replays");
const perContact = a["per-contact"] ? Number(a["per-contact"]) : 0;
const batchSize = Math.min(Number(a.batch), INGEST_LIMITS.max_items);

/** AgentWatch's judge_kind for each of codecast's judge names, and the column holding the judgment's subject. */
const JUDGES = {
  comms: { kind: "comms", subjectCol: "contact_id" },
  match: { kind: "match", subjectCol: "match_id" },
  call: { kind: "call_eval", subjectCol: "call_id" },
} as const;
type Judge = keyof typeof JUDGES;
const judges = a.judges!.split(",").map((j) => j.trim()).filter(Boolean) as Judge[];
for (const j of judges) if (!(j in JUDGES)) fail(`--judges takes ${Object.keys(JUDGES).join(", ")}; got ${j}`);
const kinds = Object.fromEntries(a.kinds!.split(",").map((p) => p.split("=").map((s) => s.trim()))) as Record<Judge, string>;
for (const j of judges) if (!kinds[j]) fail(`--kinds names no moment kind for ${j}`);

// ── The trial's source and its key ──

const cast = (args: string[]) => {
  const r = spawnSync("cast", args, { encoding: "utf8", cwd: a.union });
  if (r.status !== 0) fail(`cast ${args.join(" ")}: ${(r.stderr || r.stdout).trim()}`);
  return JSON.parse(r.stdout);
};
// A dry run reads Union and prints what it would send, so it needs no source yet.
const key = (a.key ?? process.env.CODECAST_INGEST_KEY ?? "").trim();
if (!a.dry) {
  const source = cast(["sources", "show", a.source!, "--json"]);
  if (!source.keyed) fail(`${a.source} is not a keyed source; moments come in through a keyed (sdk or http) source's door`);
  if (!key) fail(`Pass the trial source's ingest key: --key, or $CODECAST_INGEST_KEY (it starts ${source.key_prefix ?? "cc_ing_"})`);
  if (source.key_prefix && !key.startsWith(source.key_prefix)) fail(`That key is not ${a.source}'s (its key starts ${source.key_prefix})`);
  if (source.status === "paused") fail(`${a.source} is paused: the door would drop every event`);
}
const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".codecast/config.json"), "utf8"));
const site = (a.site ?? String(config.convex_url).replace(".cloud", ".site")).replace(/\/$/, "");

/** Each kind's quiet window, from its extractor's header in Union's checkout, the way publish reads it. */
const quietOf = (kind: string): number => {
  const file = path.join(a.union!, ".codecast/moments", `${kind}.ts`);
  return fs.existsSync(file) ? parseExtractorHeader(fs.readFileSync(file, "utf8")).quiet_ms : DEFAULT_QUIET_MS;
};

// ── State ──

fs.mkdirSync(a.dir!, { recursive: true });
const file = (name: string) => path.join(a.dir!, name);
const readJsonl = (name: string): any[] => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const appendJsonl = (name: string, rows: unknown[]) => rows.length && fs.appendFileSync(file(name), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

const parseSince = (s: string, until: Date): Date => {
  const m = /^(\d+)([dh])$/.exec(s);
  if (m) return new Date(until.getTime() - Number(m[1]) * (m[2] === "d" ? 86_400_000 : 3_600_000));
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) fail(`--since takes 14d, 36h or an ISO time; got ${s}`);
  return d;
};
let window: { since: string; until: string; source: string; created_at: string };
if (fs.existsSync(file("window.json"))) {
  window = JSON.parse(fs.readFileSync(file("window.json"), "utf8"));
  if (window.source !== a.source) fail(`${a.dir} replays into ${window.source}, not ${a.source}; use another --dir`);
} else {
  const until = a.until ? new Date(a.until) : new Date();
  window = { since: parseSince(a.since!, until).toISOString(), until: until.toISOString(), source: a.source!, created_at: new Date().toISOString() };
  if (!a.dry) fs.writeFileSync(file("window.json"), JSON.stringify(window, null, 1));
}
const sentScores = new Set(readJsonl("sent.jsonl").map((r) => r.score as string));
const doneContacts = new Set(readJsonl("contacts.jsonl").map((r) => r.contact as string));

// ── Union's read-only database ──

const env = await Bun.file(path.join(a.union!, "outreach/backend/.env")).text().catch(() => "");
const url = (process.env.READONLY_DATABASE_URL ?? env.match(/^READONLY_DATABASE_URL=(.*)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
if (!url) fail("READONLY_DATABASE_URL is not set and Union's outreach/backend/.env has none");
const { default: postgres } = await import(path.join(a.union!, "outreach/backend/node_modules/postgres"));
const sql = postgres(url, { max: 1, ssl: "require", idle_timeout: 5 });
const since = new Date(window.since);
const until = new Date(window.until);

try {
  // Contacts by their newest AgentWatch judgment in the window, across the judges asked for.
  const parts = [];
  if (judges.includes("comms")) parts.push(sql`SELECT contact_id AS cid, judged_at FROM agent_watch_scores WHERE judge_kind = 'comms' AND judged_at > ${since} AND judged_at <= ${until}`);
  if (judges.includes("match")) parts.push(sql`SELECT mp.contact_id AS cid, s.judged_at FROM agent_watch_scores s JOIN match_parties mp ON mp.match_id = s.match_id WHERE s.judge_kind = 'match' AND s.judged_at > ${since} AND s.judged_at <= ${until}`);
  if (judges.includes("call")) parts.push(sql`SELECT c.contact_id AS cid, s.judged_at FROM agent_watch_scores s JOIN calls c ON c.id = s.call_id WHERE s.judge_kind = 'call_eval' AND s.judged_at > ${since} AND s.judged_at <= ${until}`);
  const union = parts.reduce((acc, p) => sql`${acc} UNION ALL ${p}`);
  const ranked: Array<{ cid: string; last: Date }> = await sql`SELECT cid, max(judged_at) AS last FROM (${union}) s WHERE cid IS NOT NULL GROUP BY cid ORDER BY last DESC`;
  const take = ranked.filter((r) => !doneContacts.has(r.cid)).slice(0, contactsWanted);
  const contactIds = take.map((r) => r.cid);
  if (!contactIds.length) {
    console.log(JSON.stringify({ window, contacts: 0, note: `every contact AgentWatch judged in the window is replayed (${ranked.length})` }));
    process.exit(0);
  }

  // Every judgment of those contacts in the window: their comms, the matches they are party to, their calls.
  type Score = { id: string; judge_kind: string; contact_id: string | null; match_id: string | null; call_id: string | null; judged_at: Date; trigger_event: string | null; trigger_seq: string | null; health_score: number | null; scores_by_dim: unknown; reasoning: any; judge_metadata: any };
  const cols = sql`s.id, s.judge_kind, s.contact_id, s.match_id, s.call_id, s.judged_at, s.trigger_event, s.trigger_seq, s.health_score, s.scores_by_dim, s.reasoning, s.judge_metadata`;
  const window_ = sql`s.judged_at > ${since} AND s.judged_at <= ${until}`;
  const parties: Array<{ match_id: string; contact_id: string }> = judges.includes("match") ? await sql`SELECT match_id, contact_id FROM match_parties WHERE contact_id = ANY(${contactIds}::uuid[])` : [];
  const matchIds = [...new Set(parties.map((p) => p.match_id))];
  const callRows: Array<{ id: string; contact_id: string }> = judges.includes("call") ? await sql`SELECT id, contact_id FROM calls WHERE contact_id = ANY(${contactIds}::uuid[])` : [];
  const callIds = callRows.map((c) => c.id);
  const scores: Score[] = [
    ...(judges.includes("comms") ? await sql`SELECT ${cols} FROM agent_watch_scores s WHERE s.judge_kind = 'comms' AND s.contact_id = ANY(${contactIds}::uuid[]) AND ${window_}` : []),
    ...(matchIds.length ? await sql`SELECT ${cols} FROM agent_watch_scores s WHERE s.judge_kind = 'match' AND s.match_id = ANY(${matchIds}::uuid[]) AND ${window_}` : []),
    ...(callIds.length ? await sql`SELECT ${cols} FROM agent_watch_scores s WHERE s.judge_kind = 'call_eval' AND s.call_id = ANY(${callIds}::uuid[]) AND ${window_}` : []),
  ];

  // Which taken contact each judgment belongs to (a match has two parties; the first taken claims it).
  const callContact = new Map(callRows.map((c) => [c.id, c.contact_id]));
  const matchContacts = new Map<string, string[]>();
  for (const p of parties) matchContacts.set(p.match_id, [...(matchContacts.get(p.match_id) ?? []), p.contact_id]);
  const order = new Map(contactIds.map((c, i) => [c, i]));
  const ownerOf = (s: Score): string =>
    s.contact_id ?? (s.call_id ? callContact.get(s.call_id)! : [...(matchContacts.get(s.match_id!) ?? [])].sort((x, y) => order.get(x)! - order.get(y)!)[0]!);

  // --per-contact keeps each contact's newest judgments.
  const byContact = new Map<string, Score[]>();
  for (const s of scores) byContact.set(ownerOf(s), [...(byContact.get(ownerOf(s)) ?? []), s]);
  const kept: Score[] = [];
  for (const list of byContact.values()) {
    list.sort((x, y) => +y.judged_at - +x.judged_at);
    kept.push(...(perContact > 0 ? list.slice(0, perContact) : list));
  }

  // AgentWatch's findings from these judgments, and the clusters they sit in.
  // Findings carry no index on their score, so each subject's own index narrows the read first.
  const ids = kept.map((s) => s.id);
  const subjectsOf = [sql`contact_id = ANY(${contactIds}::uuid[])`, ...(matchIds.length ? [sql`match_id = ANY(${matchIds}::uuid[])`] : []), ...(callIds.length ? [sql`call_id = ANY(${callIds}::uuid[])`] : [])];
  const findings: any[] = ids.length
    ? await sql`
      SELECT id, source_score_id, judge_kind, cluster_id, cluster_method, cluster_similarity, cause_id,
             expectation_id, expectations_version, valence, primary_dimension, severity, confidence, title, description, evidence_quote, status, dismiss_reason
      FROM agent_watch_findings
      WHERE (${subjectsOf.reduce((acc, p) => sql`${acc} OR ${p}`)}) AND source_score_id = ANY(${ids}::uuid[])`
    : [];
  const clusterIds = [...new Set(findings.map((f) => f.cluster_id).filter(Boolean))];
  const clusters: any[] = clusterIds.length
    ? await sql`SELECT id, judge_kind, title, status, finding_count, contact_count, avg_severity, first_seen_at, last_seen_at, primary_cause_id, dissolved_into_cause_id, resolved_at, resolution_kind FROM agent_watch_finding_clusters WHERE id = ANY(${clusterIds}::uuid[])`
    : [];
  const findingsOf = new Map<string, any[]>();
  for (const f of findings) findingsOf.set(f.source_score_id, [...(findingsOf.get(f.source_score_id) ?? []), f]);

  // One event per judgment not sent before, placed on the moment it will join by event time.
  const judgeOf = (k: string): Judge => (k === "call_eval" ? "call" : (k as Judge));
  const fresh = kept.filter((s) => !sentScores.has(s.id)).sort((x, y) => +x.judged_at - +y.judged_at);
  const momentOf = new Map<string, { key: string; first: number; last: number }>();
  const rows = fresh.map((s) => {
    const judge = judgeOf(s.judge_kind);
    const kind = kinds[judge];
    const subject = (s as any)[JUDGES[judge].subjectCol] as string;
    const at = new Date(s.judged_at).getTime();
    const chainKey = `${kind}|${subject}`;
    const prev = momentOf.get(chainKey);
    const moment = prev && at <= prev.last + quietOf(kind) ? { ...prev, last: at } : { key: `${kind}:${subject}:${at}`, first: at, last: at };
    momentOf.set(chainKey, moment);
    const refs: Record<string, string> = { as_of: new Date(at).toISOString(), score: s.id, judge, replay: "agentwatch" };
    if (s.trigger_event) refs.trigger = s.trigger_event;
    if (s.judge_metadata?.triggerMessageId) refs.message = s.judge_metadata.triggerMessageId;
    if (judge !== "comms") refs.contact = ownerOf(s);
    return {
      event: { type: "moment", kind, subject, at, refs },
      record: {
        score: s.id,
        judge,
        kind,
        subject,
        contact: ownerOf(s),
        at: new Date(at).toISOString(),
        moment_key: moment.key,
        aw: {
          trigger: s.trigger_event,
          trigger_seq: s.trigger_seq,
          health: s.health_score,
          dims: s.scores_by_dim,
          summary: s.reasoning?.summary ?? null,
          deviations: s.reasoning?.deviations ?? [],
          expectations: s.judge_metadata?.expectations ?? null,
        },
        findings: (findingsOf.get(s.id) ?? []).map((f) => ({
          id: f.id,
          cluster: f.cluster_id,
          issue_key: f.cluster_id ? `union:cluster:${f.cluster_id}` : null,
          cluster_method: f.cluster_method,
          cluster_similarity: f.cluster_similarity,
          cause: f.cause_id,
          expectation: f.expectation_id,
          expectations_version: f.expectations_version,
          valence: f.valence,
          dimension: f.primary_dimension,
          severity: f.severity,
          confidence: f.confidence,
          title: f.title,
          description: f.description,
          quote: f.evidence_quote,
          status: f.status,
          dismiss_reason: f.dismiss_reason,
        })),
      },
    };
  });
  // A moment's event time is its newest event's, known once every event of the chain is placed.
  const lastOf = new Map<string, number>();
  for (const r of rows) lastOf.set(r.record.moment_key, Math.max(lastOf.get(r.record.moment_key) ?? 0, r.event.at));
  for (const r of rows) (r.record as any).moment_event_at = new Date(lastOf.get(r.record.moment_key)!).toISOString();

  const summary = {
    run_at: new Date().toISOString(),
    source: a.source,
    window: { since: window.since, until: window.until },
    contacts: contactIds.length,
    judgments: { total: kept.length, already_sent: kept.length - fresh.length, by_judge: Object.fromEntries(judges.map((j) => [j, rows.filter((r) => r.record.judge === j).length])) },
    moments: Object.fromEntries(judges.map((j) => [kinds[j], [...lastOf.keys()].filter((k) => k.startsWith(`${kinds[j]}:`)).length])),
    findings: rows.reduce((n, r) => n + r.record.findings.length, 0),
    deviations: rows.reduce((n, r) => n + r.record.aw.deviations.length, 0),
    clusters: clusterIds.length,
    sent: 0,
    dropped: 0,
    dry: a.dry,
  };

  if (a.dry) {
    console.log(JSON.stringify({ ...summary, sample: rows.slice(0, 3).map((r) => r.event) }, null, 1));
    process.exit(0);
  }

  // Clusters first: a sent line may name any of them.
  const known = fs.existsSync(file("clusters.json")) ? JSON.parse(fs.readFileSync(file("clusters.json"), "utf8")) : {};
  for (const c of clusters) known[c.id] = { ...c, read_at: new Date().toISOString() };
  fs.writeFileSync(file("clusters.json"), JSON.stringify(known, null, 1));

  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const resp = await fetch(`${site}/cli/ingest/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sdk: { name: "agentwatch-replay", version: "1" }, items: chunk.map((r) => r.event) }),
    });
    const answer: any = await resp.json().catch(() => null);
    if (!resp.ok || !answer || answer.accepted === 0) fail(`The door answered ${resp.status}: ${JSON.stringify(answer)?.slice(0, 300)}; ${summary.sent} sent before it, recorded in ${file("sent.jsonl")}`);
    const refused = new Set<number>((answer.rejected ?? []).map((r: { index: number }) => r.index));
    const sentAt = new Date().toISOString();
    appendJsonl("sent.jsonl", chunk.filter((_, j) => !refused.has(j)).map((r) => ({ ...r.record, sent_at: sentAt })));
    summary.sent += chunk.length - refused.size;
    summary.dropped += answer.dropped ?? 0;
    if (refused.size) console.error(`refused: ${JSON.stringify(answer.rejected)}`);
  }
  appendJsonl("contacts.jsonl", take.map((r) => ({ contact: r.cid, newest_judgment: new Date(r.last).toISOString(), judgments: byContact.get(r.cid)?.length ?? 0, run_at: summary.run_at })));
  appendJsonl("runs.jsonl", [summary]);
  console.log(JSON.stringify(summary, null, 1));
} finally {
  await sql.end();
}
