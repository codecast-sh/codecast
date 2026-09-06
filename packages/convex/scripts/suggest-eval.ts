// Composer-suggestion eval: grade the EXACT prod pipeline (predictSuggestions,
// so buildPrompt + completion + sanitize) against what the developer actually
// typed next. A prompt change is proven here, by ablation, not by eyeballing.
//
//   bun scripts/suggest-eval.ts --build-fixtures /tmp/sess.json --out /tmp/fixtures.json
//       Freeze a set of real moments from `cast sessions -a --json > /tmp/sess.json`
//       (owned sessions, newest first). Fixtures hold transcripts — keep them out of the repo.
//   bun scripts/suggest-eval.ts --fixtures /tmp/fixtures.json --out /tmp/run-a.json
//       Run the current prompt over every moment, judge each against the truth, print totals.
//   bun scripts/suggest-eval.ts --compare /tmp/run-a.json /tmp/run-b.json
//       Side-by-side totals and every moment whose grade moved.
//
// A moment is an assistant turn the developer replied to by typing. The
// pipeline sees the conversation up to that turn (the same 60-row window
// getSuggestionContext reads, replayed as of that moment) plus the
// developer's stored profile; the judge sees the developer's real next
// message and grades the pills:
//   hit     — a pill says what they typed (they would have sent it as-is or with a trivial edit)
//   partial — same direction, materially different content
//   miss    — pills shown, none of them right
//   silent  — no pills. Right when the truth is a correction only they could write.
// A moment whose truth is a bare nudge ("continue") is graded apart: silence
// is right there, and a shown pill is unknowable rather than wrong (they may
// have clicked it instead of typing the nudge). Precision counts substantive
// truths only.
//
// ANTHROPIC_API_KEY comes from the environment, else from the deployment
// (`npx convex env get`), so the key never touches argv.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  isConversationTurn,
  isGenericNudge,
  isMachineCarrierText,
  isMachineDrivenConversation,
  normalizeForMatch,
  predictSuggestions,
  type StoredProfile,
} from "../convex/composerSuggestions";

type Turn = { role: string; content: string; timestamp?: number };
type Context = Parameters<typeof predictSuggestions>[0];
type Fixture = {
  id: string; // `${conversation_id}#${index}`
  title?: string;
  user_id: string;
  context: Context;
  truth: string;
};
type Grade = "hit" | "partial" | "miss" | "silent" | "nudge-silent" | "nudge-shown";
type Result = { id: string; title?: string; grade: Grade; suggestions: string[]; truth: string; why: string };

const CONVEX_CWD = new URL("..", import.meta.url).pathname;
const JUDGE_MODEL = "claude-haiku-4-5-20251001";

function convexRun(fn: string, args: unknown): any {
  const r = spawnSync("npx", ["convex", "run", fn, JSON.stringify(args)], {
    encoding: "utf8",
    env: { ...process.env, CONVEX_DEPLOYMENT: "" },
    cwd: CONVEX_CWD,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  // A null result prints nothing.
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

function apiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const r = spawnSync("npx", ["convex", "env", "get", "ANTHROPIC_API_KEY"], {
    encoding: "utf8",
    env: { ...process.env, CONVEX_DEPLOYMENT: "" },
    cwd: CONVEX_CWD,
  });
  const key = r.stdout.trim();
  if (r.status !== 0 || !key) throw new Error("ANTHROPIC_API_KEY: not in env and `npx convex env get` failed");
  process.env.ANTHROPIC_API_KEY = key;
  return key;
}

// Whole conversations come from the dashboard's system table reader (admin
// key from .env.local), index-scoped so only that conversation is walked. No
// deploy needed, and no debug query left behind in prod.
const ADMIN_KEY = (() => {
  try {
    const line = readFileSync(`${CONVEX_CWD}.env.local`, "utf8").split("\n").find((l) => l.startsWith("CONVEX_SELF_HOSTED_ADMIN_KEY="));
    return line?.slice(line.indexOf("=") + 1).trim() ?? "";
  } catch { return ""; }
})();

async function systemQuery(path: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch("https://convex.codecast.sh/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Convex ${ADMIN_KEY}` },
    body: JSON.stringify({ path, args: { ...args, componentId: null }, format: "json" }),
  });
  const data: any = await res.json();
  if (data.status === "error") throw new Error(data.errorMessage);
  return data.value;
}

async function fetchConversation(conversationId: string): Promise<{ conversation: any; raw: any[] } | null> {
  const conversation = await systemQuery("_system/frontend/getById", { id: conversationId });
  if (!conversation) return null;
  const filters = Buffer.from(JSON.stringify({
    clauses: [],
    order: "asc",
    index: { name: "by_conversation_timestamp", clauses: [{ type: "indexEq", enabled: true, value: conversationId }] },
  })).toString("base64");
  const raw: any[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await systemQuery("_system/frontend/paginatedTableDocuments", {
      table: "messages", filters, paginationOpts: { numItems: 500, cursor },
    });
    raw.push(...page.page);
    if (page.isDone || raw.length >= 4000) break;
    cursor = page.continueCursor;
  }
  return { conversation, raw };
}

// A user turn the developer typed, as opposed to a machine carrier — the
// same test the habit miner applies. A pasted wall is not a reply either.
function isTyped(t: Turn): boolean {
  const text = t.content.trim();
  return !!text && !isMachineCarrierText(text) && text.length <= 2000;
}

// Every (assistant turn → typed developer reply) pair in one conversation,
// newest first, capped so one chatty session cannot dominate the set, and at
// most one nudge moment per session so a "continue" habit does not drown the
// substantive replies. The context at each moment is what
// getSuggestionContext would have returned then: the 60 newest raw rows
// ending at the assistant turn, filtered to real turns.
const CONTEXT_ROWS = 60;
function momentsOf(
  conversationId: string,
  conv: any,
  raw: any[],
  maxPerSession: number,
): Fixture[] {
  const out: Fixture[] = [];
  const conversation = {
    user_id: conv.user_id, title: conv.title, subtitle: conv.subtitle, idle_summary: conv.idle_summary,
    thread_state: conv.thread_state, project_path: conv.project_path, git_branch: conv.git_branch, status: conv.status,
  };
  let nudges = 0;
  for (let i = raw.length - 2; i >= 1 && out.length < maxPerSession; i--) {
    const reply = raw[i + 1];
    if (raw[i].role !== "assistant" || !isConversationTurn(raw[i])) continue;
    if (reply.role !== "user" || !isConversationTurn(reply) || !isTyped(reply)) continue;
    if (isGenericNudge(reply.content) && nudges++ >= 1) continue;
    const turns: Turn[] = raw.slice(Math.max(0, i - CONTEXT_ROWS + 1), i + 1)
      .filter(isConversationTurn)
      .map((m) => ({ role: m.role, content: m.content || "", timestamp: m.timestamp }));
    out.push({
      id: `${conversationId}#${i}`,
      title: conv.title,
      user_id: conv.user_id,
      context: { conversation, turns },
      truth: reply.content.trim(),
    });
  }
  return out;
}

async function buildFixtures(sessionsPath: string, maxSessions: number, maxPerSession: number): Promise<Fixture[]> {
  if (!ADMIN_KEY) throw new Error("CONVEX_SELF_HOSTED_ADMIN_KEY not found in packages/convex/.env.local");
  const sessions: any[] = JSON.parse(readFileSync(sessionsPath, "utf8")).sessions;
  const picked = sessions.filter((s) => (s.message_count ?? 0) >= 12).slice(0, maxSessions);
  const fixtures: Fixture[] = [];
  for (const s of picked) {
    const fetched = await fetchConversation(s.id);
    if (!fetched || isMachineDrivenConversation(fetched.conversation)) continue;
    const moments = momentsOf(s.id, fetched.conversation, fetched.raw, maxPerSession);
    fixtures.push(...moments);
    process.stderr.write(`${s.id} ${String(s.title ?? "").slice(0, 40)}: ${fetched.raw.length} rows, ${moments.length} moments\n`);
  }
  return fixtures;
}

async function judge(f: Fixture, suggestions: string[], key: string): Promise<{ grade: Grade; why: string }> {
  if (isGenericNudge(f.truth)) return { grade: suggestions.length ? "nudge-shown" : "nudge-silent", why: "truth is a bare nudge" };
  if (!suggestions.length) return { grade: "silent", why: "no pills" };
  const agentTail = [...f.context.turns].reverse().find((t) => t.role === "assistant")?.content ?? "";
  const prompt = `A coding agent said something; the developer then typed a reply. Separately, a system had predicted the developer's reply as one or more suggested messages, shown before they typed. Grade the prediction.

Agent's message (end of it):
"""
${agentTail.slice(-1500)}
"""

What the developer ACTUALLY typed next:
"""
${f.truth}
"""

Predicted suggestions:
${suggestions.map((s, i) => `${i + 1}. """${s}"""`).join("\n")}

Grade with ONE of:
- hit: at least one suggestion says what the developer typed — same request, same decision or same answer — such that they would have sent it as written or with a trivial edit.
- partial: a suggestion heads the same direction but its content differs materially (asks for something else, adds or drops a real requirement, answers a different question).
- miss: no suggestion matches. Includes: the developer corrected the agent or changed course while the suggestions assumed the agent was right; the developer asked something the suggestions do not touch.

Return ONLY JSON: {"grade": "hit" | "partial" | "miss", "why": "one short sentence"}`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: JUDGE_MODEL, max_tokens: 200, temperature: 0, messages: [{ role: "user", content: prompt }] }),
  });
  const data: any = await res.json();
  const raw = data.content?.[0]?.text?.trim() ?? "";
  try {
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""));
    const grade = ["hit", "partial", "miss"].includes(parsed.grade) ? parsed.grade : "miss";
    return { grade, why: String(parsed.why ?? "") };
  } catch {
    return { grade: "miss", why: `judge returned: ${raw.slice(0, 120)}` };
  }
}

// The stored profile is current, so it can contain the very message the
// moment predicts; at that moment it had not been typed yet. Removing it keeps
// the replay ban from deleting an exact hit.
function scrubTruth(profile: StoredProfile, truth: string): StoredProfile {
  const key = normalizeForMatch(truth);
  return {
    ...profile,
    recent: profile.recent.filter((t) => normalizeForMatch(t) !== key),
    frequent: profile.frequent.filter((f) => normalizeForMatch(f.text) !== key),
    patterns: profile.patterns?.filter((p) => normalizeForMatch(p.example) !== key),
  };
}

async function runFixtures(fixtures: Fixture[], key: string, concurrency: number): Promise<Result[]> {
  const profiles = new Map<string, StoredProfile | null>();
  for (const f of fixtures) {
    if (profiles.has(f.user_id)) continue;
    profiles.set(f.user_id, convexRun("composerSuggestions:getSuggestionProfile", { user_id: f.user_id }));
  }
  const skipped = fixtures.filter((f) => !profiles.get(f.user_id)).length;
  if (skipped) console.log(`skipping ${skipped} moments whose owner has no suggestion profile yet`);
  fixtures = fixtures.filter((f) => profiles.get(f.user_id));
  const results: Result[] = new Array(fixtures.length);
  let next = 0;
  const worker = async () => {
    while (next < fixtures.length) {
      const i = next++;
      const f = fixtures[i];
      const predicted = await predictSuggestions(f.context, scrubTruth(profiles.get(f.user_id)!, f.truth), "anthropic");
      const suggestions = predicted.error ? [] : predicted.suggestions;
      const graded = predicted.error
        ? { grade: "silent" as Grade, why: `pipeline error: ${predicted.error}` }
        : await judge(f, suggestions, key);
      results[i] = { id: f.id, title: f.title, ...graded, suggestions, truth: f.truth };
      process.stdout.write({ hit: "✓", partial: "~", miss: "✗", silent: "·", "nudge-silent": "_", "nudge-shown": "?" }[graded.grade]);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stdout.write("\n");
  return results;
}

function totals(results: Result[]) {
  const count = (g: Grade) => results.filter((r) => r.grade === g).length;
  const hit = count("hit"), partial = count("partial"), miss = count("miss"), silent = count("silent");
  const nudgeSilent = count("nudge-silent"), nudgeShown = count("nudge-shown");
  const n = hit + partial + miss + silent;
  const shown = hit + partial + miss;
  return {
    n, hit, partial, miss, silent, nudgeSilent, nudgeShown,
    // Of the pills shown at substantive moments, how many were right — the
    // cost side (a wrong pill teaches the developer to ignore the feature).
    precision: shown ? hit / shown : 0,
    // Of all substantive moments, how many got a right pill — the value side.
    coverage: n ? hit / n : 0,
  };
}

function printTotals(label: string, t: ReturnType<typeof totals>) {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  console.log(`${label}: substantive n=${t.n} hit=${t.hit} partial=${t.partial} miss=${t.miss} silent=${t.silent} | precision ${pct(t.precision)} coverage ${pct(t.coverage)} | nudge moments: silent=${t.nudgeSilent} shown=${t.nudgeShown}`);
}

function printResults(results: Result[]) {
  for (const r of results) {
    if (r.grade === "silent" || r.grade === "nudge-silent") continue;
    console.log(`\n[${r.grade}] ${r.title ?? r.id}\n  truth: ${r.truth.replace(/\s+/g, " ").slice(0, 160)}`);
    for (const s of r.suggestions) console.log(`  pill:  ${s.replace(/\s+/g, " ").slice(0, 160)}`);
    console.log(`  why:   ${r.why}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const out = flag("--out");

  if (flag("--build-fixtures")) {
    const fixtures = await buildFixtures(flag("--build-fixtures")!, Number(flag("--max-sessions") ?? 40), Number(flag("--max-per-session") ?? 3));
    if (!out) throw new Error("--out required");
    writeFileSync(out, JSON.stringify(fixtures));
    console.log(`${fixtures.length} moments → ${out}`);
    return;
  }

  if (flag("--compare")) {
    const i = argv.indexOf("--compare");
    const a: Result[] = JSON.parse(readFileSync(argv[i + 1], "utf8"));
    const b: Result[] = JSON.parse(readFileSync(argv[i + 2], "utf8"));
    printTotals("A", totals(a));
    printTotals("B", totals(b));
    const byId = new Map(a.map((r) => [r.id, r]));
    for (const rb of b) {
      const ra = byId.get(rb.id);
      if (!ra || ra.grade === rb.grade) continue;
      console.log(`\n${ra.grade} → ${rb.grade}  ${rb.title ?? rb.id}\n  truth: ${rb.truth.replace(/\s+/g, " ").slice(0, 160)}`);
      for (const s of ra.suggestions) console.log(`  A:     ${s.replace(/\s+/g, " ").slice(0, 160)}`);
      for (const s of rb.suggestions) console.log(`  B:     ${s.replace(/\s+/g, " ").slice(0, 160)}`);
    }
    return;
  }

  const fixturesPath = flag("--fixtures");
  if (!fixturesPath) throw new Error("usage: --build-fixtures <sessions.json> --out f.json | --fixtures f.json [--out run.json] | --compare a.json b.json");
  const key = apiKey();
  const fixtures: Fixture[] = JSON.parse(readFileSync(fixturesPath, "utf8"));
  const results = await runFixtures(fixtures, key, Number(flag("--concurrency") ?? 4));
  if (out) writeFileSync(out, JSON.stringify(results, null, 2));
  if (argv.includes("--verbose")) printResults(results);
  printTotals("run", totals(results));
}

main().catch((e) => { console.error(e); process.exit(2); });
