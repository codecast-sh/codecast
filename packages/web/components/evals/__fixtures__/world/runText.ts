// Part of the fixture world (../world.ts), which every caller imports. The
// text the run pages read: moments, replies, the prompt files each rep wrote,
// guard lines and a run's folder. Nothing here is real data.

import type { CallDetail, EvalFlip, GuardEntry, GuardStatus, MomentMessage, RunFileEntry, RunResponse, RunRow } from "@codecast/shared/contracts/evalsApi";
import { flipOf, gradedSet, type PromptReader } from "@platform/evals/analysis";
import { DAY, type FixtureState, JUDGE_MODEL, PASS_MARK, clamp01, fixturePolicy, iso, round, surfaceDef } from "./model";

// ── Text the run pages read ─────────────────────────────────────────────────

/** How each freeze's moment ends: the human's question, the agent's answer ending on a question back, and what a "done" reading would claim. */
const CLOSERS: Array<{ ask: string; answer: string; done: string }> = [
  { ask: "Does this need a deploy, or is it client only?", answer: "Client only. Want me to open the PR or leave it in the tree?", done: "The fix is in the tree and tests pass." },
  { ask: "Did the migration run on staging too?", answer: "It ran on staging. Should I run it on prod now, or wait for the window?", done: "The migration ran on staging." },
  { ask: "Can you check the flaky test while you're there?", answer: "The flake is a timer race; I pinned the clock. Same fix in the other two suites?", done: "The flaky test is fixed and the clock is pinned." },
  { ask: "What's left on the export bug?", answer: "The CSV path is fixed. The PDF path still drops its header; should I take that next?", done: "The CSV export is fixed." },
  { ask: "Is the webhook retry safe to ship?", answer: "It is idempotent now. Behind the flag, or straight to everyone?", done: "The retry is idempotent and ready." },
];

/** One closer per freeze, seeded by its id, so two flips never show the same moment. */
const closerOf = (freezeId: string) => {
  let h = 0;
  for (let i = 0; i < freezeId.length; i++) h = (h * 31 + freezeId.charCodeAt(i)) >>> 0;
  return CLOSERS[h % CLOSERS.length];
};

export function momentOf(st: FixtureState, freezeId: string): MomentMessage[] {
  const f = st.freezes.get(freezeId);
  if (!f) return [];
  const t0 = st.now - 31 * DAY;
  const c = closerOf(freezeId);
  const lines: Array<[MomentMessage["direction"], string, string]> = [
    ["in", "Ashot", `Can you look at ${f.name.replace(/-/g, " ")}? It came up again this morning.`],
    ["out", "agent", "Reading the logs first. The failure starts after the cache warms, not at boot."],
    ["out", "agent", "Found it: the retry wraps the wrong call. Patch is in the tree, tests pass locally."],
    ["in", "Ashot", c.ask],
    ["out", "agent", c.answer],
  ];
  return lines.map(([direction, from, text], n) => ({ n: n + 1, id: `m${n + 1}`, at: iso(t0 + n * 240_000), channel: "session", isGroup: false, direction, from, text }));
}

export function replyOf(row: RunRow): string {
  const pass = row.status === "pass";
  switch (row.surface) {
    case "settle": {
      const c = closerOf(row.freezeId);
      return JSON.stringify(pass ? { state: "waiting", why: `The agent asked "${c.answer.slice(c.answer.lastIndexOf(". ") + 2)}" and has no answer.` } : { state: "done", why: c.done });
    }
    case "title":
      return pass ? `Fix ${row.freezeName.replace(/-/g, " ")} retry` : `Claude Code: ${row.freezeName}`;
    default:
      return pass
        ? `${row.freezeName.replace(/-/g, " ")}: the work is clear, the next step is named, and nothing is invented.`
        : `${row.freezeName.replace(/-/g, " ")}: a confident summary that misses the open question at the end.`;
  }
}

/** One prompt file as a rep rendered it. The rules grow with the prompt epoch the rep rendered, the one its promptSha names. */
function promptOf(st: FixtureState, row: RunRow, file: string): string {
  const def = surfaceDef(st, row.surface);
  const epoch = st.promptEpochs.get(row.id) ?? 1;
  const extra = epoch >= 2 ? "\n- If the human was asked anything, the session is waiting, whatever else is true." : "";
  const extra3 = epoch >= 3 ? "\n- A finished fix with tests passing is done. Prefer done when work is verified." : "";
  if (file.endsWith("system.md")) return `You read one coding session and answer for the ${def.id} surface.\n\nRules:\n- Read the last assistant turn first.${extra}${extra3}\n- Answer in JSON only.`;
  if (file.endsWith("then2.md")) return "Anything else you would do before ending the turn?";
  return momentOf(st, row.freezeId).map((m) => `${m.from}: ${m.text}`).join("\n");
}

/** What an agent typed, per mark: real-shaped commands, cycled when a count outruns the list. */
const GUARD_ARGV: Record<GuardStatus, string[]> = {
  SERVED: ["cast feed --since 1d", "cast task ls -q sync", "cast plan show pl-810", "cast read jx7c6zk 40:60", "cast sessions --label growth", "cast task show ct-4102", "cast search \"weekly digest\" -s 7d", "cast decisions list", "cast pr ls --mine", "cast calls -n 3", "cast doc search \"growth plan\"", "cast trigger ls", "cast task ready -q growth", "cast chat read --channel growth --since 1d", "cast summary jx7dhfh", "cast plan ls -q growth", "cast diff jx7c6zk", "cast feed --label growth", "cast task ls --assignee me", "cast usage"],
  UNSERVED: ["cast plan context pl-810", "cast call cl-212 --transcript"],
  LIVE: ["cast sessions --state needs-input", "cast feed --since 2h", "cast task ls -s in_progress"],
  REFUSED: ['cast task comment ct-4102 "done"'],
  UNKNOWN: ["cast roster"],
  HELP: ["cast trigger --help"],
};

function guardOf(row: RunRow): GuardEntry[] {
  const out: GuardEntry[] = [];
  const push = (status: GuardStatus, n: number, turn: number, from = 0) => {
    const list = GUARD_ARGV[status];
    for (let i = 0; i < n; i++) out.push({ seq: out.length + 1, turn, argv: list[(from + i) % list.length], status });
  };
  push("SERVED", Math.min(row.guard.served, 4), 1);
  push("HELP", row.guard.help, 1);
  push("SERVED", Math.max(0, row.guard.served - 4), 2, 4);
  push("UNSERVED", row.guard.unserved, 2);
  push("LIVE", row.guard.live, 2);
  push("UNKNOWN", row.guard.unknown, 2);
  push("REFUSED", row.guard.refused, 2);
  return out;
}

/** The prompt files a rep of this route wrote, in the order the model saw them. */
const promptFilesOf = (route: string) => (route === "agent" ? ["agent1/prompt.md", "agent1/then2.md"] : ["call1/system.md", "call1/prompt.md"]);

/** The world's prompt files, as the epoch walk, the prompt diffs and attribution read them from run folders. */
export function promptReader(st: FixtureState): PromptReader {
  const text = (runId: string, file: string) => {
    const row = st.byId.get(runId);
    return row && promptFilesOf(surfaceDef(st, row.surface).route).includes(file) ? promptOf(st, row, file) : null;
  };
  return {
    files: (runId) => {
      const row = st.byId.get(runId);
      return row ? promptFilesOf(surfaceDef(st, row.surface).route) : [];
    },
    text,
    size: (runId, file) => {
      const t = text(runId, file);
      return t === null ? null : byteLength(t);
    },
  };
}

/** What the judge wrote about a check it scored. */
const judgeNote = (score: number) => (score >= PASS_MARK ? "It answers the question the moment asks and invents nothing." : "It reads as finished, but the session ended on an unanswered question.");

/** A rep's folder as codecast reads it: everything on its page but the row and its neighbours, which the query adds. */
export type FixtureRunDetail = Omit<RunResponse, "row" | "siblings" | "adjacent">;

export function runDetail(st: FixtureState, row: RunRow): FixtureRunDetail {
  const def = surfaceDef(st, row.surface);
  const scored = row.status === "pass" || row.status === "fail";
  // A dry rep calls no model: a call's reply is its prompt echoed back (adapters/dryRun.ts), an agent's a fixed line.
  const dry = row.status === "dry";
  const reply = dry ? (def.route === "call" ? promptOf(st, row, "call1/prompt.md") : "(dry run: no agent ran)") : replyOf(row);
  const calls: CallDetail[] =
    def.route === "call" && row.status !== "crash"
      ? [{ n: 1, dir: "call1", request: { model: row.model ?? def.model, max_tokens: 1024, temperature: 0 }, system: promptOf(st, row, "call1/system.md"), prompt: promptOf(st, row, "call1/prompt.md"), reply, stopReason: "end_turn", tokens: dry ? { input: null, output: Math.ceil(reply.length / 4), cacheRead: null, cacheWrite: null } : { input: 2140, output: 96, cacheRead: 1800, cacheWrite: 0 }, costUsd: row.costUsd, realMs: row.realMs, isError: false, harnessFailure: null }]
      : [];
  const agents =
    def.route === "agent" && row.status !== "crash"
      ? [{
          n: 1,
          dir: "agent1",
          model: row.model ?? def.model,
          prompt: promptOf(st, row, "agent1/prompt.md"),
          then: [promptOf(st, row, "agent1/then2.md")],
          turns: dry ? [[{ kind: "text" as const, text: reply }]] : [
            [{ kind: "thinking" as const, text: "Start from what changed since the last check." }, { kind: "tool" as const, name: "Bash", input: { command: "cast feed --since 1d" }, output: "12 events since yesterday", isError: false }, { kind: "text" as const, text: reply }],
            [{ kind: "text" as const, text: "Nothing else: the open items belong to other roles." }],
          ],
          said: [reply],
          brief: "You are the infra lead. Check what changed since you last looked.",
          args: { model: row.model ?? def.model, call: false, maxOutputTokens: null, tools: ["Bash", "Read"], maxTurns: 12, serve: "served/", guard: "guard/" },
          tokens: { input: 48_000, output: 2_100, cacheRead: 40_000, cacheWrite: 6_000 },
          costUsd: row.costUsd,
        }]
      : [];
  const gates = [
    { id: "no-leak", title: "No private text leaks into the reply", pass: !row.gatesFailed.includes("no-leak"), decidedBy: "mechanical" as const, evidence: row.gatesFailed.includes("no-leak") ? { summary: "The reply quotes a private channel name.", scanned: 1, excerpts: [{ where: "reply", text: "#founders-only" }] } : { summary: "Scanned 1 reply, nothing private.", scanned: 1 } },
    { id: "shape", title: "The reply parses", pass: true, decidedBy: "mechanical" as const, evidence: { summary: "Held, nothing to check.", vacuous: true } },
  ];
  // The tool grades a dry rep too, scoring the echoed prompt as if it were a reply: real dry folders mostly fail `parse` at 0.
  const dryScore = dry
    ? { pass: false, score: 0, passMark: PASS_MARK, gates: [{ id: "shape", title: "The reply parses", pass: false, decidedBy: "mechanical" as const, evidence: { summary: `not JSON: the reply starts "${reply.slice(0, 32)}"` } }], checks: [], missedFloors: [], judgeCostUsd: 0, judgeModel: null, scoredAt: iso(Date.parse(row.stamp) + 2_000) }
    : null;
  const score = scored
    ? {
        pass: row.status === "pass",
        score: row.score as number,
        passMark: PASS_MARK,
        gates,
        checks: Object.entries(row.checks).map(([id, s]) => ({ id, ask: id === "criteria" ? def.criteria : "Does it sound like the person, not like a model?", weight: id === "criteria" ? 0.7 : 0.3, score: s, must: id === "criteria" ? 0.4 : null, reasoning: judgeNote(s), evidence: null })),
        missedFloors: row.missedFloors.map((id) => ({ id, score: row.checks[id] ?? 0, must: 0.4 })),
        judgeCostUsd: row.judgeCostUsd,
        judgeModel: row.judgeModel,
        scoredAt: iso(Date.parse(row.stamp) + 90_000),
      }
    : dryScore;
  // Sizes come from the texts the file route serves (runFileTexts), so the tree and the open file agree.
  const files: RunFileEntry[] = [
    { path: "run.json", kind: "file", size: 0 },
    { path: "result.json", kind: "file", size: 0 },
    ...(score ? [{ path: "score.json", kind: "file" as const, size: 0 }] : []),
    { path: "sends.json", kind: "file", size: 0 },
    ...(calls.length ? [{ path: "call1", kind: "dir" as const, size: 0 }, { path: "call1/system.md", kind: "file" as const, size: 0 }, { path: "call1/prompt.md", kind: "file" as const, size: 0 }, { path: "call1/reply.md", kind: "file" as const, size: 0 }] : []),
    ...(agents.length ? [{ path: "agent1", kind: "dir" as const, size: 0 }, { path: "agent1/prompt.md", kind: "file" as const, size: 0 }, { path: "agent1/then2.md", kind: "file" as const, size: 0 }, { path: "agent1/stream.jsonl", kind: "file" as const, size: 0 }, { path: "calls.log", kind: "file" as const, size: 0 }] : []),
    ...(row.status === "crash" ? [{ path: "run.log", kind: "file" as const, size: 0 }] : []),
  ];
  const res: FixtureRunDetail = {
    run: { freezeId: row.freezeId, notes: null, model: row.model ?? def.model, route: def.route, sourceHash: row.sourceHash ?? "", sourceHashDisk: row.sourceHashDisk, treePatch: row.treePatch, freezeSha: row.freezeSha, promptSha: row.promptSha, judgeModel: row.judgeModel, budgetUsd: 8, gitHead: row.gitHead ?? "", dirty: row.dirty, dry: row.status === "dry", temperatureProd: [0], temperatureReplay: "cli-default", liveReads: row.liveReads, batch: row.batch ?? "", cadence: row.cadence, title: `${row.surface} ${row.freezeName}` },
    result: { scenario: row.freezeName, seed: row.seed, title: `${row.surface} ${row.freezeName}`, startedAt: row.stamp, endedBecause: row.status === "crash" ? "failed" : "done", stopReason: row.status === "crash" ? "the replay exited 1 before replying" : null, steps: calls.length + agents.length, virtualElapsedMs: 0, realElapsedMs: row.realMs, costUsd: row.costUsd, captures: 1 },
    score,
    scoreVersions: score
      ? [
          ...(row.scoreVersions > 1 ? [{ file: "score.before-rejudge.json", scoredAt: null, judgeModel: JUDGE_MODEL, score: round(clamp01((row.score as number) + 0.06)), pass: true, legacy: true }] : []),
          { file: "score.json", scoredAt: score.scoredAt ?? null, judgeModel: score.judgeModel, score: score.score, pass: score.pass, legacy: false },
        ]
      : [],
    rubric: score ? null : { criteria: def.criteria, passMark: PASS_MARK },
    sends: row.status === "crash" ? [] : [{ seq: 1, at: row.stamp, label: def.id, rail: def.route === "agent" ? "chat" : "result", to: null, audience: "founder", text: reply, chars: reply.length }],
    calls,
    agents,
    judge: scored ? { model: row.judgeModel, prompt: `Grade the reply against: ${def.criteria}`, reply: JSON.stringify({ score: row.score }), costUsd: row.judgeCostUsd } : null,
    guard: def.route === "agent" ? guardOf(row) : [],
    files,
    logTail: row.status === "crash" ? "replay: spawning claude -p\nerror: the model returned an empty stream\n    at readStream (adapters/replay.ts:211)\nexit 1" : null,
    extra: row.surface === "org-review" ? { gradeAuto: { named: 7, exist: 7, owners: 6 }, hashes: { analyzer: row.promptSha } } : null,
  };
  const texts = runFileTexts(res);
  return { ...res, files: files.map((f) => (f.kind === "dir" ? f : { ...f, size: byteLength(texts.get(f.path) ?? "") })) };
}

/**
 * The reply text behind flips between two batches, for the before and after
 * cards: per freeze, both sides' graded reps handed to the engine's flipOf,
 * which picks one rep a side that matches its side's verdict.
 */
export function flipExamples(st: FixtureState, surface: string, freezeIds: string[], a: string, b: string): EvalFlip[] {
  const mine = st.rows.filter((r) => r.surface === surface);
  const side = (batch: string, freezeId: string) => ({
    batch,
    sha: "",
    reps: gradedSet(mine, batch).filter((r) => r.freezeId === freezeId).map((r) => ({ passed: fixturePolicy.passed(r), score: r.score, reply: replyOf(r), judge_note: judgeNote(r.checks.criteria ?? r.score ?? 0), cost_usd: r.costUsd, gates_failed: r.gatesFailed })),
  });
  return freezeIds.flatMap((id) => {
    const flip = flipOf({ freeze: id, name: st.freezes.get(id)?.name ?? id.slice(0, 8), kind: "guard", proven: false, input: momentOf(st, id).slice(-2).map((m) => `${m.from}: ${m.text}`).join(" "), base: side(a, id), branch: side(b, id) });
    return flip ? [flip] : [];
  });
}

export const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** Each file of a run folder as the file route serves it. */
export function runFileTexts(r: FixtureRunDetail): Map<string, string> {
  const map: Record<string, unknown> = {
    "run.json": r.run,
    "result.json": r.result,
    "score.json": r.score,
    "sends.json": r.sends,
    "call1/system.md": r.calls[0]?.system,
    "call1/prompt.md": r.calls[0]?.prompt,
    "call1/reply.md": r.calls[0]?.reply,
    "agent1/prompt.md": r.agents[0]?.prompt,
    "agent1/then2.md": r.agents[0]?.then[0],
    "agent1/stream.jsonl": r.agents[0]?.turns.flat().map((t) => JSON.stringify(t)).join("\n"),
    "calls.log": r.guard.map((g) => `${g.argv}\n# ${g.status}`).join("\n"),
    "run.log": r.logTail,
  };
  const out = new Map<string, string>();
  for (const [path, v] of Object.entries(map)) if (v !== undefined && v !== null) out.set(path, typeof v === "string" ? v : JSON.stringify(v, null, 2));
  return out;
}
