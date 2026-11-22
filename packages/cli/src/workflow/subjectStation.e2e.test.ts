// End to end (flows.md FL4): a session's change is the run's subject. Its check
// fails, the failure comes back to the session as a message, the session fixes
// its own checkout, the run freezes the change again and Check passes on it.
// The session hears Decide's answer and how the run ended. Real git and real
// transcripts in an isolated CODECAST_DIR and HOME; the server is a fake that
// plays the session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { freezeSessionChange, writeFrozenChange } from "./flowChange";
import { readFrozenChange } from "./flowChangeFile";
import { parseWorkflowSource } from "./parser";
import { lineRunDir, runSlug, runWorkflow, type RunOptions } from "./runner";
import { readCheckpoint } from "./runResume";
import { startSubjectParker } from "./subjectPark";
import { failureExcerpt, runEndMessage } from "./subjectStation";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
const saved: Record<string, string | undefined> = {};
let sandbox = "";
let origFetch: typeof fetch;
let origLog: typeof console.log;

beforeAll(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-subject-e2e-")));
  for (const [k, v] of Object.entries({ ...ENV, HOME: sandbox, CODECAST_DIR: path.join(sandbox, ".codecast") })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  origFetch = globalThis.fetch;
  origLog = console.log;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  globalThis.fetch = origFetch;
  console.log = origLog;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, ...ENV, GIT_AUTHOR_DATE: HOUR_AGO, GIT_COMMITTER_DATE: HOUR_AGO } }).replace(/\n$/, "");
const CONV = "jx7ssssssssssssssssssssssssssss1";

let worlds = 0;
/** A shared checkout where session CONV changed a.txt, its transcript saying so; `edit` writes any file as the session. */
function world(content: string) {
  process.env.CODECAST_DIR = path.join(sandbox, `.codecast-${++worlds}`);
  const root = path.join(sandbox, `repo-${worlds}`);
  fs.mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "a.txt"), "base\n");
  fs.writeFileSync(path.join(root, "b.txt"), "base\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  const dir = path.join(sandbox, ".claude", "projects", `-repo-${worlds}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `sess-${worlds}.jsonl`);
  const lines: object[] = [];
  const edit = (text: string, name = "a.txt") => {
    fs.writeFileSync(path.join(root, name), text);
    lines.push({ type: "assistant", timestamp: new Date().toISOString(), cwd: root, message: { role: "assistant", content: [{ type: "tool_use", id: `t${lines.length}`, name: "Edit", input: { file_path: path.join(root, name), old_string: "x", new_string: "y" } }] } });
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const ledgerFile = path.join(process.env.CODECAST_DIR!, "sync-ledger.json");
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    fs.writeFileSync(ledgerFile, JSON.stringify({ [file]: { lastSyncedAt: Date.now(), lastSyncedPosition: 0, messageCount: lines.length, conversationId: CONV, sourceGeneration: { client: "claude", sessionId: `sess-${worlds}`, dev: 0, ino: 0, birthtimeMs: 0, unit: "bytes", watermark: 0, prefixProven: true } } }));
  };
  edit(content);
  // The check segment beside the graph: it reads the frozen branch, the way a real check reads the run's worktree.
  fs.writeFileSync(path.join(root, "tcheck.cast"), `digraph tcheck {
    graph [kind="segment", label="Check"]
    start [shape=Mdiamond]
    verify [label="Verify", shape=parallelogram, script="v=$(git -C $project_path show $branch:a.txt); echo \\"line 1 fine\\"; [ \\"$v\\" = good ] || { echo \\"error: a.txt says $v, expected good\\"; exit 1; }"]
    passed [shape=Msquare, label="Passed"]
    failed [shape=Msquare, label="Checks failed", stop="The project's check failed on the change: $verify.output"]
    start -> verify
    verify -> passed [condition="outcome = success"]
    verify -> failed [condition="outcome = failure"]
  }`);
  return { root, edit };
}

const graphIn = (root: string) => parseWorkflowSource(`digraph change {
  graph [label="Change", on_failure=stop]
  start [shape=Mdiamond]
  check [flow="tcheck"]
  fix_check [label="Fix check", backend=subject, max_visits=3, prompt="Check failed on $task_id.\\n\\n$stop_reason"]
  decide [label="Decide", shape=hexagon, prompt="Ship it?"]
  exit [shape=Msquare, label="Done"]
  start -> check
  check -> decide
  check -> fix_check [condition="outcome = failure"]
  fix_check -> check
  decide -> exit [label="[S] Ship :: Land it"]
}`, root);

type Play = {
  /** The session pins dormant when it ends its turn. */
  dormant?: boolean;
  /** When that dormant pin was set; by default as it is read, so after any brief. */
  pinnedAt?: number;
  /** Fields the session's row reads with, over a settled live one; `briefed` says whether a brief has reached it. */
  row?: (briefed: boolean) => Record<string, unknown>;
  /** How many reads a brief's answer takes to show in the transcript (the station waits on it meanwhile). */
  lag?: number;
  /** The repository's deploy targets, read when the run asks (`cast line deploy targets`); none by default. */
  targets?: () => unknown[];
  /** What the server answers a retire with. */
  retire?: () => Record<string, unknown>;
  /** The server is older than `quiet` and refuses a send that carries it. */
  refuseQuiet?: boolean;
  /** A gate's answers, one per card the run raises; Ship by default. */
  answers?: string[];
};

/** The server, playing the session: `fix` is what the session does when a brief reaches it. */
function server(fix: () => void, play: Play = {}) {
  const { dormant = false } = play;
  const calls: Array<{ route: string; body: any }> = [];
  let messages = 10;
  let briefed = false;
  let lagLeft = 0;
  let owed = 0;
  // The run's stash puts the row out of sight; a send that is not quiet brings it back.
  let stashed = false;
  // A message the server already holds under a client_id is not queued again (enqueuePendingMessage).
  const held = new Set<string>();
  let cards = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    const route = String(url).replace(/^https?:\/\/[^/]+/, "");
    const body = JSON.parse(init?.body || "{}");
    calls.push({ route, body });
    const reply = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (route === "/cli/work/get") return reply({ title: "Make a.txt good", status: "in_progress" });
    if (route === "/cli/inbox") {
      if (lagLeft > 0) lagLeft--;
      else { messages += owed; owed = 0; }
      return reply({ sessions: [{ id: CONV, work_state: dormant ? "dormant" : "done", bucket: stashed ? "stashed" : "done", is_live: true, is_killed: false, message_count: messages, ...play.row?.(briefed) }] });
    }
    if (route === "/cli/sessions/state/get" && dormant) return reply({ state: "Fixed it; the run re-checks when this turn ends", status: "dormant", at: play.pinnedAt ?? Date.now() });
    if (route === "/cli/sessions/dismiss") stashed = true;
    if (route === "/cli/deploys/targets") return reply({ targets: play.targets?.() ?? [] });
    if (route === "/cli/sessions/retire") return reply(play.retire?.() ?? { retired: true, short_id: CONV.slice(0, 7) });
    if (route === "/cli/messages/send") {
      if (play.refuseQuiet && body.quiet) return new Response(JSON.stringify({ error: "ArgumentValidationError: Object contains extra field `quiet`" }), { status: 400 });
      if (body.client_id && held.has(body.client_id)) return reply({ ok: true });
      if (body.client_id) held.add(body.client_id);
      if (!body.quiet) stashed = false;
      // A brief starts a turn; the run's end and a gate's answer only inform.
      if (/^Check failed/.test(body.body)) {
        briefed = true;
        fix();
        lagLeft = play.lag ?? 0;
        owed += 3;
      } else messages += 3;
      return reply({ ok: true });
    }
    if (route === "/cli/workflow-runs/gate") { cards++; return reply({ ok: true }); }
    if (route === "/cli/workflow-runs/poll-gate") return reply({ status: "running", gate_response: play.answers?.[Math.max(0, cards - 1)] ?? "S" });
    return reply({ ok: true });
  }) as typeof fetch;
  return {
    calls,
    sent: () => calls.filter((c) => c.route === "/cli/messages/send").map((c) => c.body),
    // What reached the session: a resend under a client_id it already holds is not a second message.
    delivered: () => calls.filter((c, i) => c.route === "/cli/messages/send" && !(c.body.client_id && calls.slice(0, i).some((p) => p.route === "/cli/messages/send" && p.body.client_id === c.body.client_id))).map((c) => c.body),
  };
}

async function start(root: string, graph = graphIn(root), opts: { only?: string[]; run?: Partial<RunOptions> } = {}) {
  const runDir = lineRunDir(root, runSlug(graph, { task_id: "ct-9" }, "run"));
  const change = await freezeSessionChange(root, CONV, { branch: "codecast/change-ct-9", worktree: "change-ct-9", title: "Make a.txt good", only: opts.only });
  writeFrozenChange(runDir, change);
  const t0 = Date.now();
  console.log = process.env.SHOW_RUN ? (...a: unknown[]) => origLog(`${Date.now() - t0}ms`, ...a) : () => {};
  try {
    const outcome = await runWorkflow(graph, { cwd: root, taskId: "ct-9", runId: "run-9", runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1, ...opts.run });
    return { outcome, runDir };
  } finally {
    console.log = origLog;
  }
}

describe("the session is the run's subject", () => {
  test("a failed check comes back to the session, it fixes it, the run freezes again and goes on; it hears the answer and the end", async () => {
    const { root, edit } = world("bad\n");
    const s = server(() => edit("good\n"));
    const { outcome, runDir } = await start(root);
    expect(outcome).toBe("completed");

    const [brief, answer, end] = s.sent();
    expect(brief.to).toBe(CONV);
    expect(brief.from).toBe("conv_run");
    expect(brief.body).toContain("Check failed on ct-9");
    expect(brief.body).toContain("error: a.txt says bad, expected good");
    expect(answer.body).toMatch(/^Decide: Ship\./);
    // The gate's answer is news: quiet, so a subject out of sight stays there.
    expect(answer.quiet).toBe(true);
    expect(end.quiet).toBeUndefined();
    expect(end.body).toContain("The Change run on ct-9 is over: Done.");
    expect(s.sent()).toHaveLength(3);

    // What ships is the snapshot the run checked: the frozen branch holds the fix, the shared tree is untouched.
    expect(git(root, "show", "codecast/change-ct-9:a.txt")).toBe("good");
    expect(readFrozenChange(runDir)?.tip).toBe(git(root, "rev-parse", "codecast/change-ct-9"));
    expect(git(root, "rev-parse", "HEAD")).toBe(git(root, "rev-parse", "main"));
    expect(git(root, "status", "--porcelain", "--", "a.txt")).toBe(" M a.txt");

    // The run said it waited on the session, and then that it no longer does; Check's second visit is counted.
    const progress = s.calls.filter((c) => c.route === "/cli/workflow-runs/progress").map((c) => c.body);
    const waits = progress.filter((b) => "waiting_on_session" in b).map((b) => b.waiting_on_session);
    expect(waits[0]).toMatchObject({ node_id: "fix_check", conversation_id: CONV });
    expect(waits[0].note).toContain("expected good");
    expect(waits[1]).toBeNull();
    expect(progress.some((b) => b.node_id === "check" && b.visits === 2)).toBe(true);
    // The session is never reported as a hand of the run's.
    expect(progress.some((b) => b.session_id)).toBe(false);
  }, 60_000);

  test("a session that pins dormant naming the run as its wake has answered: the run goes on (ct-85419)", async () => {
    const { root, edit } = world("bad\n");
    const s = server(() => edit("good\n"), { dormant: true });
    const { outcome } = await start(root);
    expect(outcome).toBe("completed");
    expect(s.sent().at(-1)!.body).toContain("is over: Done.");
  }, 60_000);

  test("a dormant pin from before the brief is not its answer: the run waits for the turn the brief started to end (ct-98624)", async () => {
    const { root, edit } = world("bad\n");
    // Its row reads dormant throughout (the pin it left last turn). After the brief it works a while, between tool
    // calls too (an idle status while the transcript grows), fixes a.txt at the end of the turn and goes quiet.
    let reads = 0;
    const s = server(() => {}, {
      dormant: true,
      pinnedAt: Date.now() - 3_600_000,
      row: (briefed) => {
        if (!briefed) return {};
        reads++;
        if (reads < 12) return { agent_status: reads % 4 ? "working" : "idle", message_count: 20 + reads };
        if (reads === 12) edit("good\n");
        return { agent_status: "idle", message_count: 40 };
      },
    });
    const { outcome } = await start(root);
    expect(outcome).toBe("completed");
    expect(reads).toBeGreaterThanOrEqual(14);
    // One brief: the run froze the change only once the turn had ended, so Check passed on the fix.
    expect(s.sent().filter((m) => /^Check failed/.test(m.body))).toHaveLength(1);
    expect(git(root, "show", "codecast/change-ct-9:a.txt")).toBe("good");
  }, 60_000);

  test("a session that never fixes it is sent back three times, then the run stops and says why", async () => {
    const { root } = world("bad\n");
    const s = server(() => {});
    const { outcome } = await start(root);
    expect(outcome).toBe("failed");
    const sent = s.sent();
    expect(sent.filter((m) => /^Check failed/.test(m.body))).toHaveLength(3);
    expect(sent.at(-1)!.body).toContain("stopped at Fix check: Check sent the change back 3 times and it still does not pass.");
  }, 60_000);
});

describe("the subject between its turns: restarted, parked, retired", () => {
  const routes = (s: ReturnType<typeof server>, route: string) => s.calls.filter((c) => c.route === route).map((c) => c.body);
  const indexOf = (s: ReturnType<typeof server>, match: (c: { route: string; body: any }) => boolean) => s.calls.findIndex(match);

  test("a killed subject is sent the brief like any other, which restarts it, and the run completes", async () => {
    const { root, edit } = world("bad\n");
    const s = server(() => edit("good\n"), { row: (briefed) => (briefed ? {} : { is_killed: true, is_live: false, work_state: "idle" }) });
    const { outcome } = await start(root);
    expect(outcome).toBe("completed");
    expect(s.sent()[0].body).toContain("Check failed on ct-9");
    expect(git(root, "show", "codecast/change-ct-9:a.txt")).toBe("good");
  }, 60_000);

  test("a settled subject is stashed out of sight and asked to park while Check runs, never during its own station; its brief is quiet", async () => {
    const { root, edit } = world("bad\n");
    const s = server(() => edit("good\n"), { lag: 30 });
    const { outcome } = await start(root, graphIn(root), { run: { subjectParkMs: 1 } });
    expect(outcome).toBe("completed");
    const [brief] = s.sent();
    expect(brief.quiet).toBe(true);
    expect(routes(s, "/cli/sessions/dismiss")[0]).toEqual({ api_token: "tok", session: CONV, hidden: true });
    expect(routes(s, "/cli/sessions/hibernate")[0]).toEqual({ api_token: "tok", session: CONV });
    // Each settle is stashed once: the one before the first Check, and the one after the session fixed it.
    expect(routes(s, "/cli/sessions/dismiss")).toHaveLength(2);
    // Hibernate is asked again no sooner than five minutes later.
    expect(routes(s, "/cli/sessions/hibernate")).toHaveLength(1);
    // Nothing parks the session between its brief and its settle, though it read settled through the whole lag.
    const sentAt = indexOf(s, (c) => c.route === "/cli/messages/send" && /^Check failed/.test(c.body.body));
    const settledAt = indexOf(s, (c) => c.route === "/cli/workflow-runs/progress" && c.body.waiting_on_session === null);
    const parkedDuring = s.calls.slice(sentAt, settledAt).filter((c) => c.route === "/cli/sessions/dismiss" || c.route === "/cli/sessions/hibernate");
    expect(settledAt - sentAt).toBeGreaterThan(30);
    expect(parkedDuring).toEqual([]);
    // The quiet brief's run sends the end message as usual: the change did not land.
    expect(s.sent().at(-1)!.body).toContain("is over: Done.");
  }, 60_000);

  test("a working subject is left alone", async () => {
    const { root } = world("good\n");
    const s = server(() => {}, { row: () => ({ work_state: "working" }) });
    expect((await start(root, graphIn(root), { run: { subjectParkMs: 1 } })).outcome).toBe("completed");
    expect(routes(s, "/cli/sessions/dismiss")).toEqual([]);
    expect(routes(s, "/cli/sessions/hibernate")).toEqual([]);
  }, 60_000);

  test("a subject that settles in the middle of a long station is parked then, not only between stations", async () => {
    const { root } = world("good\n");
    // It works until a moment after Wait has started, then settles.
    let settleAt = Infinity;
    const waitRunning = (c: { route: string; body: any }) => c.route === "/cli/workflow-runs/progress" && c.body.node_id === "wait" && c.body.node_status === "running";
    const s: ReturnType<typeof server> = server(() => {}, {
      row: () => {
        if (settleAt === Infinity && s.calls.some(waitRunning)) settleAt = Date.now() + 200;
        return Date.now() < settleAt ? { work_state: "working" } : {};
      },
    });
    const graph = parseWorkflowSource(`digraph slow {
      graph [label="Slow"]
      start [shape=Mdiamond]
      wait [label="Wait", shape=parallelogram, script="sleep 1"]
      exit [shape=Msquare, label="Done"]
      start -> wait -> exit
    }`, root);
    expect((await start(root, graph, { run: { subjectParkMs: 20 } })).outcome).toBe("completed");
    const waitRan = indexOf(s, waitRunning);
    const waitDone = indexOf(s, (c) => c.route === "/cli/workflow-runs/progress" && c.body.node_id === "wait" && c.body.node_status === "completed");
    const stashed = indexOf(s, (c) => c.route === "/cli/sessions/dismiss");
    expect(stashed).toBeGreaterThan(waitRan);
    expect(stashed).toBeLessThan(waitDone);
  }, 60_000);

  test("a subject a person brought back from the run's stash is parked no more, and the run's context remembers it", async () => {
    const { root } = world("good\n");
    // Once the run has stashed it, a person restores it (it files in the inbox again at the same settle); later it
    // works a turn and settles again, which the run would otherwise stash anew.
    const dismissed = () => s.calls.filter((c) => c.route === "/cli/sessions/dismiss").length;
    let restoredReads = 0;
    const s: ReturnType<typeof server> = server(() => {}, {
      row: () => {
        if (!dismissed()) return {};
        restoredReads++;
        return { bucket: "done", ...(restoredReads > 5 ? { message_count: 40 } : {}) };
      },
    });
    const graph = parseWorkflowSource(`digraph slow {
      graph [label="Slow"]
      start [shape=Mdiamond]
      wait [label="Wait", shape=parallelogram, script="sleep 1"]
      after [label="After", shape=parallelogram, script="true"]
      exit [shape=Msquare, label="Done"]
      start -> wait -> after -> exit
    }`, root);
    const { outcome, runDir } = await start(root, graph, { run: { subjectParkMs: 20 } });
    expect(outcome).toBe("completed");
    expect(restoredReads).toBeGreaterThan(5);
    expect(dismissed()).toBe(1);
    expect(readCheckpoint(runDir, "run-9")?.context.subject_kept).toBe("1");
  }, 60_000);

  test("a parker does nothing until it is bound to the run's context, so a resumed runner reads subject_kept first", async () => {
    const calls: string[] = [];
    const read = async (route: string) => { calls.push(route); return { sessions: [{ id: CONV, work_state: "done", bucket: "done", is_live: true, message_count: 3 }] }; };
    const kept = startSubjectParker(read, { conversationId: CONV, shortId: "jx7ssss" }, 1, () => {});
    await kept.tick();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual([]);
    kept.bind({ subject_kept: "1" });
    await new Promise((r) => setTimeout(r, 30));
    await kept.stop();
    expect(calls).toEqual([]);
    const fresh = startSubjectParker(read, { conversationId: CONV, shortId: "jx7ssss" }, 1, () => {});
    fresh.bind({});
    await new Promise((r) => setTimeout(r, 30));
    await fresh.stop();
    expect(calls).toContain("/cli/sessions/dismiss");
  });

  test("a parker bound to a run whose context says a person kept the subject does nothing", async () => {
    const calls: string[] = [];
    const parker = startSubjectParker(async (route) => { calls.push(route); return { sessions: [{ id: CONV, work_state: "done", bucket: "done", is_live: true, message_count: 3 }] }; }, { conversationId: CONV, shortId: "jx7ssss" }, 60_000, () => {});
    parker.bind({ subject_kept: "1" });
    await parker.tick();
    await parker.stop();
    expect(calls.filter((r) => r !== "/cli/inbox")).toEqual([]);
  });

  test("every send to the subject carries one client_id; a server that refuses quiet gets the same send plain, under the same id", async () => {
    const { root, edit } = world("bad\n");
    const s = server(() => edit("good\n"), { refuseQuiet: true });
    expect((await start(root)).outcome).toBe("completed");
    const briefs = s.sent().filter((m) => /^Check failed/.test(m.body));
    expect(briefs.map((b) => b.quiet)).toEqual([true, undefined]);
    expect(briefs[0].client_id).toMatch(/^run:run-9:fix_check:[0-9a-f]{8}$/);
    expect(briefs[1].client_id).toBe(briefs[0].client_id);
    const answers = s.sent().filter((m) => /^Decide: Ship\./.test(m.body));
    expect(answers.map((a) => a.quiet)).toEqual([true, undefined]);
    expect(answers[0].client_id).toMatch(/^run:run-9:decide\.answer:[0-9a-f]{8}$/);
    expect(answers[1].client_id).toBe(answers[0].client_id);
    expect(s.sent().at(-1)!.client_id).toMatch(/^run:run-9:end:[0-9a-f]{8}$/);
  }, 60_000);

  test("a second Revise and a second answer on the same gate each reach the subject: no send repeats another's client_id", async () => {
    const { root } = world("good\n");
    // A person answers Revise twice, then Wait (a look again that comes back to the card), then Ship. Each answer
    // starts the visit counts over, so a key built on them repeated, and the server dropped the repeat.
    const graph = parseWorkflowSource(`digraph change {
      graph [label="Change", on_failure=stop]
      start [shape=Mdiamond]
      check [flow="tcheck"]
      decide [label="Decide", shape=hexagon, prompt="Ship it?"]
      revise [label="Revise", backend=subject, max_visits=3, prompt="Revise on $task_id: $human.message"]
      look [label="Look", shape=parallelogram, script="true"]
      exit [shape=Msquare, label="Done"]
      start -> check -> decide
      decide -> revise [label="[R] Revise :: Change it"]
      decide -> look [label="[W] Wait :: Look again"]
      decide -> exit [label="[S] Ship :: Land it"]
      revise -> check
      look -> decide
    }`, root);
    const s = server(() => {}, { answers: ["R", "R", "W", "S"] });
    expect((await start(root, graph)).outcome).toBe("completed");
    const delivered = s.delivered();
    expect(delivered.filter((m) => /^Revise on ct-9/.test(m.body))).toHaveLength(2);
    expect(delivered.filter((m) => /^Decide: /.test(m.body)).map((m) => m.body.split(".")[0])).toEqual(["Decide: Wait", "Decide: Ship"]);
    const ids = s.sent().map((m) => m.client_id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 60_000);

  const PUSH = "git -C $project_path push -q origin $branch:main";
  /** A checkout with an origin, and a flow whose Land runs `land`: PUSH puts the frozen change on origin's main, `true` lands nothing. */
  function landWorld(land: string) {
    const w = world("good\n");
    // Under a github.com path, so the checkout names its repository the way a GitHub origin does.
    const origin = path.join(sandbox, "github.com", "acme", `app-${worlds}.git`);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    git(w.root, "remote", "add", "origin", origin);
    git(w.root, "push", "-q", "origin", "main");
    git(w.root, "fetch", "-q", "origin");
    const graph = parseWorkflowSource(`digraph change {
      graph [label="Change", on_failure=stop]
      start [shape=Mdiamond]
      check [flow="tcheck"]
      land [label="Land", shape=parallelogram, script="${land}"]
      exit [shape=Msquare, label="Done"]
      start -> check -> land -> exit
    }`, w.root);
    return { ...w, graph };
  }

  test("a subject whose change is live and that has no other work is retired: killed, not told", async () => {
    const { root, graph } = landWorld(PUSH);
    const s = server(() => {});
    expect((await start(root, graph)).outcome).toBe("completed");
    expect(git(root, "show", "origin/main:a.txt")).toBe("good");
    // Retired through the server's guarded kill, with the transcript length the run read it settled at.
    expect(routes(s, "/cli/sessions/retire")).toEqual([{ api_token: "tok", session: CONV, expected_message_count: 10 }]);
    expect(routes(s, "/cli/sessions/kill")).toEqual([]);
    expect(routes(s, "/cli/deploys/targets")[0]).toMatchObject({ repository: `acme/app-${worlds}` });
    expect(s.sent()).toEqual([]);
    const end = routes(s, "/cli/workflow-runs/progress").find((b) => b.run_status === "completed");
    expect(end.result_preview).toMatch(/^Retired jx7ssss: its change is live from main at [0-9a-f]{10} and it has no other work\.$/);
  }, 60_000);

  test("a parked subject is retired too, and is not resumed to hear a gate's answer", async () => {
    const { root } = landWorld(PUSH);
    const graph = parseWorkflowSource(`digraph change {
      graph [label="Change", on_failure=stop]
      start [shape=Mdiamond]
      decide [label="Decide", shape=hexagon, prompt="Ship it?"]
      land [label="Land", shape=parallelogram, script="git -C $project_path push -q origin $branch:main"]
      exit [shape=Msquare, label="Done"]
      start -> decide
      decide -> land [label="[S] Ship :: Land it"]
      land -> exit
    }`, root);
    const s = server(() => {}, { row: () => ({ is_live: false, agent_status: "hibernated" }) });
    expect((await start(root, graph)).outcome).toBe("completed");
    expect(s.sent()).toEqual([]);
    expect(routes(s, "/cli/sessions/retire")).toHaveLength(1);
    // Nothing to park: it already is.
    expect(routes(s, "/cli/sessions/hibernate")).toEqual([]);
  }, 60_000);

  test("merged is not live: a touched target still running a deploy from before the change keeps the subject, who hears the end", async () => {
    const { root, graph } = landWorld(PUSH);
    const before = git(root, "rev-parse", "main");
    const s = server(() => {}, { targets: () => [{ name: "web", paths: ["a.txt"], live: { short_id: "dp-1", status: "live", sha: before, created_at: 1, live_at: 1 } }] });
    expect((await start(root, graph)).outcome).toBe("completed");
    expect(routes(s, "/cli/sessions/retire")).toEqual([]);
    expect(s.sent().at(-1)!.body).toContain("The Change run on ct-9 is over: Done.");
  }, 60_000);

  test("a touched target live at a deploy that holds the change retires the subject; a target the change does not touch is not waited on", async () => {
    const { root, graph } = landWorld(PUSH);
    const before = git(root, "rev-parse", "main");
    const s = server(() => {}, {
      targets: () => [
        { name: "web", paths: ["a.txt"], live: { short_id: "dp-2", status: "live", sha: git(root, "rev-parse", "origin/main"), created_at: 2, live_at: 2 } },
        { name: "docs", paths: ["docs/**"], live: { short_id: "dp-3", status: "live", sha: before, created_at: 1, live_at: 1 } },
      ],
    });
    expect((await start(root, graph)).outcome).toBe("completed");
    expect(routes(s, "/cli/sessions/retire")).toHaveLength(1);
    expect(s.sent()).toEqual([]);
  }, 60_000);

  test("a target the checkout declares but the server has never listed is not live: the subject stays", async () => {
    const { root, graph } = landWorld(PUSH);
    fs.mkdirSync(path.join(root, ".codecast"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codecast", "deploy.toml"), `[[target]]\nname = "web"\nruns = "push"\nwhen = ["a.txt"]\nlive = "marker"\n`);
    git(root, "add", ".codecast/deploy.toml");
    git(root, "commit", "-qm", "declare web");
    const s = server(() => {});
    expect((await start(root, graph)).outcome).toBe("completed");
    expect(routes(s, "/cli/sessions/retire")).toEqual([]);
    expect(s.sent().at(-1)!.body).toContain("The Change run on ct-9 is over: Done.");
  }, 60_000);

  test("a retire the server refuses (the session moved, a trigger is armed) leaves the subject, who hears the end", async () => {
    const { root, graph } = landWorld(PUSH);
    const s = server(() => {}, { retire: () => ({ retired: false, short_id: "jx7ssss", reason: "a trigger is armed on it" }) });
    expect((await start(root, graph)).outcome).toBe("completed");
    expect(routes(s, "/cli/sessions/retire")).toHaveLength(1);
    expect(s.sent().at(-1)!.body).toContain("The Change run on ct-9 is over: Done.");
  }, 60_000);

  test("a subject whose checkout has nothing uncommitted left (it pulled the landed main) is retired", async () => {
    const { root, graph } = landWorld(`${PUSH} && git -C $project_path reset -q --hard origin/main`);
    const s = server(() => {});
    expect((await start(root, graph)).outcome).toBe("completed");
    expect(git(root, "status", "--porcelain", "--", "a.txt")).toBe("");
    expect(routes(s, "/cli/sessions/retire")).toHaveLength(1);
    expect(s.sent()).toEqual([]);
  }, 60_000);

  test("a run that completes says nothing to a subject already stopped: no revival to read that it is over", async () => {
    const { root, graph } = landWorld("true");
    const s = server(() => {}, { row: () => ({ is_killed: true, is_live: false, work_state: "idle" }) });
    expect((await start(root, graph)).outcome).toBe("completed");
    expect(s.sent()).toEqual([]);
    expect(routes(s, "/cli/sessions/retire")).toEqual([]);
  }, 60_000);

  test("a run that fails still tells a stopped subject, which revives it so the failure reaches someone", async () => {
    const { root } = world("bad\n");
    const graph = parseWorkflowSource(`digraph change {
      graph [label="Change", on_failure=stop]
      start [shape=Mdiamond]
      check [flow="tcheck"]
      stopped [shape=Msquare, label="Checks failed", stop="$stop_reason"]
      exit [shape=Msquare, label="Done"]
      start -> check -> exit
      check -> stopped [condition="outcome = failure"]
    }`, root);
    const s = server(() => {}, { row: () => ({ is_killed: true, is_live: false, work_state: "idle" }) });
    expect((await start(root, graph)).outcome).toBe("failed");
    const told = s.sent();
    expect(told).toHaveLength(1);
    expect(told[0].body).toContain("stopped at Checks failed");
    expect(told[0].quiet).toBeUndefined();
  }, 60_000);

  test("a subject with another file of its own changed stays, and hears the end", async () => {
    const { root, edit, graph } = landWorld(PUSH);
    edit("more work\n", "b.txt");
    const s = server(() => {});
    expect((await start(root, graph, { only: ["a.txt"] })).outcome).toBe("completed");
    expect(git(root, "show", "origin/main:a.txt")).toBe("good");
    expect(routes(s, "/cli/sessions/retire")).toEqual([]);
    expect(s.sent().at(-1)!.body).toContain("The Change run on ct-9 is over: Done.");
  }, 60_000);

  test("a change that did not land leaves its subject, who hears the end", async () => {
    const { root, graph } = landWorld("true");
    const s = server(() => {});
    expect((await start(root, graph)).outcome).toBe("completed");
    expect(routes(s, "/cli/sessions/retire")).toEqual([]);
    expect(s.sent().at(-1)!.body).toContain("The Change run on ct-9 is over: Done.");
  }, 60_000);
});

describe("a change named by branch from inside a session (ct-85594)", () => {
  /** The session committed its change on its own branch and ran `cast flow run change --task ct-9 --branch feat` from inside itself. */
  function branchWorld(content: string) {
    const { root } = world("unused\n");
    git(root, "checkout", "-q", "-b", "feat");
    fs.writeFileSync(path.join(root, "a.txt"), content);
    git(root, "commit", "-qam", "the change");
    git(root, "checkout", "-q", "main");
    // The run's worktree holds the branch, so the session commits from elsewhere: here, with plumbing.
    const commit = (text: string) => {
      const blob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], { input: text, encoding: "utf-8" }).trim();
      const tree = execFileSync("git", ["-C", root, "mktree"], { input: `100644 blob ${blob}\ta.txt\n`, encoding: "utf-8" }).trim();
      const tip = git(root, "commit-tree", tree, "-p", "feat", "-m", "fix");
      git(root, "update-ref", "refs/heads/feat", tip);
    };
    return { root, commit };
  }

  async function startOnBranch(root: string, graph = graphIn(root), subject = true) {
    const runDir = lineRunDir(root, runSlug(graph, { task_id: "ct-9" }, "run"));
    const tip = git(root, "rev-parse", "feat");
    writeFrozenChange(runDir, { source: "branch", ...(subject ? { session: CONV.slice(0, 7), conversation: CONV } : {}), base: tip, tip, branch: "feat", worktree: "change-ct-9", paths: [], shared: [], held: [] });
    console.log = () => {};
    try {
      return await runWorkflow(graph, { cwd: root, taskId: "ct-9", runId: "run-9", runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1 });
    } finally {
      console.log = origLog;
    }
  }

  test("the session that started it is the subject: a failed check reaches it, it commits the fix to the branch, the run reads the branch again", async () => {
    const { root, commit } = branchWorld("bad\n");
    const s = server(() => commit("good\n"));
    expect(await startOnBranch(root)).toBe("completed");
    const [brief] = s.sent();
    expect(brief.to).toBe(CONV);
    expect(brief.body).toContain("error: a.txt says bad, expected good");
    expect(s.calls.some((c) => c.route === "/cli/work/comment" && c.body.comment_type === "blocker")).toBe(false);
  }, 60_000);

  // The check's own segment, shaped like the shipped check.cast: exit 2 is this machine's, not the change's.
  const machineGraph = (root: string) => {
    fs.writeFileSync(path.join(root, "mcheck.cast"), `digraph mcheck {
      graph [kind="segment", label="Check"]
      start [shape=Mdiamond]
      verify [label="Verify", shape=parallelogram, script="echo '{\\"ok\\":false,\\"steps\\":[{\\"name\\":\\"test database\\",\\"ok\\":false,\\"detail\\":\\"role postgres does not exist\\"}]}'; exit 2"]
      passed [shape=Msquare, label="Passed"]
      failed [shape=Msquare, label="Checks failed", stop="The project's check failed on the change: $verify.summary"]
      unjudged [shape=Msquare, label="Not checked here", machine=true, stop="This machine could not run the project's check: $verify.summary."]
      start -> verify
      verify -> passed [condition="outcome = success"]
      verify -> failed [condition="outcome = failure and verify.exit_code != 2"]
      verify -> unjudged [condition="outcome = failure and verify.exit_code = 2"]
    }`);
    return parseWorkflowSource(`digraph change {
      graph [label="Change", on_failure=stop]
      start [shape=Mdiamond]
      check [flow="mcheck"]
      fix_check [label="Fix check", backend=subject, max_visits=3, prompt="Check failed on $task_id.\\n\\n$stop_reason"]
      unchecked [shape=Msquare, label="Not checked here", machine=true, stop="$stop_reason"]
      exit [shape=Msquare, label="Done"]
      start -> check
      check -> exit
      check -> fix_check [condition="outcome = failure and check.exit != unjudged"]
      check -> unchecked [condition="outcome = failure and check.exit = unjudged"]
      fix_check -> check
    }`, root);
  };
  const comments = (s: ReturnType<typeof server>) => s.calls.filter((c) => c.route === "/cli/work/comment").map((c) => c.body);

  test("a check the machine could not run stops at once: a note on the task in the run's voice, the session told, no blocker", async () => {
    const { root } = branchWorld("good\n");
    const s = server(() => { throw new Error("the session is never asked to fix the machine"); });
    expect(await startOnBranch(root, machineGraph(root))).toBe("failed");
    const [note, ...rest] = comments(s);
    expect(rest).toEqual([]);
    expect(note).toMatchObject({ short_id: "ct-9", comment_type: "note", conversation_id: "conv_run" });
    expect(note.to_owner).toBeUndefined();
    expect(note.text).toContain("This machine could not run the project's check: test database (role postgres does not exist).");
    expect(note.text).toContain("Full output: ");
    expect(note.text).toContain("/workflows/runs/run-9");
    expect(note.text).not.toContain("{");
    expect(s.calls.find((c) => c.route === "/cli/work/update")?.body).toMatchObject({ status: "in_review" });
    const told = s.sent();
    expect(told).toHaveLength(1);
    expect(told[0].body).toContain("stopped at Not checked here: This machine could not run the project's check");
  }, 60_000);

  test("with no session behind the run, the note is for the run's owner alone", async () => {
    const { root } = branchWorld("good\n");
    const s = server(() => {});
    expect(await startOnBranch(root, machineGraph(root), false)).toBe("failed");
    expect(comments(s)[0]).toMatchObject({ comment_type: "note", conversation_id: "conv_run", to_owner: true });
    expect(s.sent()).toHaveLength(0);
  }, 60_000);
});

describe("runEndMessage", () => {
  const g = parseWorkflowSource(`digraph "quick-change" { graph [label="Quick"] start [shape=Mdiamond] exit [shape=Msquare] start -> exit }`);
  test("a stop before Land says nothing shipped and how to run it again; one after Land says the change is on main", () => {
    expect(runEndMessage(g, { taskId: "ct-1", endLabel: "Fix check", failed: true, failReason: "Stopped: Check sent the change back 3 times and it still does not pass." }))
      .toBe("The Quick run on ct-1 stopped at Fix check: Check sent the change back 3 times and it still does not pass. The change was not shipped. Run it again with `cast flow run quick-change` once it is ready.");
    expect(runEndMessage(g, { taskId: "ct-1", endLabel: "Deploy failed", failed: true, failReason: "Stopped: The deploy that carried abc failed: web dp-2 (exit 1).", landed: true }))
      .toBe("The Quick run on ct-1 stopped at Deploy failed: The deploy that carried abc failed: web dp-2 (exit 1). The change is on the default branch; nothing after this stage ran.");
  });
});

describe("failureExcerpt", () => {
  test("short output passes whole; long output keeps what broke and the end", () => {
    expect(failureExcerpt("a\n\nb\n")).toBe("a\nb");
    const long = [...Array.from({ length: 300 }, (_, i) => `ok ${i}`), "src/x.ts(3,1): error TS2339: nope", ...Array.from({ length: 300 }, (_, i) => `ok more ${i}`), "1 failed"].join("\n");
    const cut = failureExcerpt(long);
    expect(cut).toContain("error TS2339: nope");
    expect(cut).toContain("1 failed");
    expect(cut).not.toContain("ok 5\n");
    expect(cut.split("\n").length).toBeLessThanOrEqual(80);
  });
});
