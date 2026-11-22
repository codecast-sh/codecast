/**
 * Fixtures the subject station's end-to-end tests share (subjectStation.e2e.test.ts): an isolated sandbox, a checkout
 * whose session changed a file, a change graph, a fake server playing the session, and one run. Each test file calls
 * useSandbox() once.
 */
import { afterAll, beforeAll } from "bun:test";
import { execFileSync } from "../proc";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { freezeSessionChange, writeFrozenChange } from "./flowChange";
import { parseWorkflowSource } from "./parser";
import { lineRunDir, runSlug, runWorkflow, type RunOptions } from "./runner";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
const saved: Record<string, string | undefined> = {};
export let sandbox = "";
let origFetch: typeof fetch;
export let origLog: typeof console.log;

/** The isolated HOME and CODECAST_DIR every test runs in, set up once per test file. */
export function useSandbox(): void {
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
}

const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();
export const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, ...ENV, GIT_AUTHOR_DATE: HOUR_AGO, GIT_COMMITTER_DATE: HOUR_AGO } }).replace(/\n$/, "");
export const CONV = "jx7ssssssssssssssssssssssssssss1";

export let worlds = 0;
/** A shared checkout where session CONV changed a.txt, its transcript saying so; `edit` writes any file as the session. */
export function world(content: string) {
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

export const graphIn = (root: string) => parseWorkflowSource(`digraph change {
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

export type Play = {
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
export function server(fix: () => void, play: Play = {}) {
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

export async function start(root: string, graph = graphIn(root), opts: { only?: string[]; run?: Partial<RunOptions> } = {}) {
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
