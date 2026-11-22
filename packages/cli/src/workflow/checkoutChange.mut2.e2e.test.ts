// End to end (flows.md FL4): a shared checkout's whole uncommitted pass as one
// flow change (`cast flow run --checkout`). Two sessions wrote files in one
// checkout beside a credential and a stale copy; the freeze makes a commit per
// writer, as `cast ship checkout` plans a pass, cut onto freshly fetched
// upstream, and records who wrote each file. A stage's finding then goes to the
// writers of the files it names, each told its own, and the run waits for all
// of them before it freezes the pass again. Real git with a bare origin, real
// transcripts and sync ledger in an isolated CODECAST_DIR and HOME; the server
// is a fake that plays the sessions.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { freezeCheckoutChange, NoCheckoutChange, previewCheckoutChange, refreezeSessionChange, writeFrozenChange } from "./flowChange";
import { readFrozenChange } from "./flowChangeFile";
import { parseWorkflowSource } from "./parser";
import { lineRunDir, runSlug, runWorkflow } from "./runner.mut2";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
const saved: Record<string, string | undefined> = {};
let sandbox = "";
let origFetch: typeof fetch;
let origLog: typeof console.log;

beforeAll(() => {
  origFetch = globalThis.fetch;
  origLog = console.log;
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-checkout-e2e-")));
  for (const [k, v] of Object.entries({ ...ENV, HOME: sandbox, CODECAST_DIR: path.join(sandbox, ".codecast") })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  globalThis.fetch = origFetch;
  console.log = origLog;
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// Commits are an hour old, so the transcripts' writes (seconds ago) come after them.
const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, ...ENV, GIT_AUTHOR_DATE: HOUR_AGO, GIT_COMMITTER_DATE: HOUR_AGO } }).replace(/\n$/, "");
const write = (dir: string, file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };

const A = "jx7aaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const B = "jx7bbbbbbbbbbbbbbbbbbbbbbbbbbbb2";
const roster = async (ids: string[]) => ids.map((id) => ({ short_id: id, title: id === A.slice(0, 7) ? "Make a.ts good" : "Make b.ts good", work_state: "done" }));

let worlds = 0;
/**
 * A shared checkout cloned from a bare origin that has since moved on. Session A
 * wrote src/a.ts and a credential, session B wrote src/b.ts, nobody's edit names
 * notes.txt, and src/c.ts is a stale copy (an older version of itself). `edit`
 * writes a file as a session, its transcript and the sync ledger saying so.
 */
function checkoutWorld() {
  process.env.CODECAST_DIR = path.join(sandbox, `.codecast-${++worlds}`);
  const dir = path.join(sandbox, `w${worlds}`);
  const origin = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  const root = path.join(dir, "shared");
  fs.mkdirSync(seed, { recursive: true });
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(seed, "init", "-q", "-b", "main");
  for (const [f, t] of Object.entries({ "src/a.ts": "export const a = 'bad';\n", "src/b.ts": "export const b = 'bad';\n", "src/c.ts": "export const c = 1;\n", "src/d.ts": "export const d = 1;\n" })) write(seed, f, t);
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "base");
  write(seed, "src/c.ts", "export const c = 1;\nexport const c2 = 2;\n");
  git(seed, "commit", "-qam", "grow c");
  git(seed, "push", "-q", origin, "main");
  git(dir, "clone", "-q", origin, root);

  // Both sessions are team visible: their commits carry the session trailer.
  fs.mkdirSync(process.env.CODECAST_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.CODECAST_DIR!, "session-links.json"), JSON.stringify(Object.fromEntries([A, B].map((c) => [`sess-${c.slice(3, 4)}`, { conversation_id: c, team_visible: true, checked_at: Date.now() }]))));
  const lines: Record<string, object[]> = { [A]: [], [B]: [] };
  const edit = (conv: string, file: string, text: string) => {
    write(root, file, text);
    const sessionId = `sess-${conv.slice(3, 4)}-${worlds}`;
    lines[conv].push({ type: "assistant", timestamp: new Date().toISOString(), cwd: root, message: { role: "assistant", content: [{ type: "tool_use", id: `t${Math.random()}`, name: "Edit", input: { file_path: path.join(root, file), old_string: "x", new_string: "y" } }] } });
    const tdir = path.join(sandbox, ".claude", "projects", `-w${worlds}`);
    fs.mkdirSync(tdir, { recursive: true });
    const tfile = path.join(tdir, `${sessionId}.jsonl`);
    fs.writeFileSync(tfile, lines[conv].map((l) => JSON.stringify(l)).join("\n") + "\n");
    const ledgerFile = path.join(process.env.CODECAST_DIR!, "sync-ledger.json");
    const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, "utf-8")) : {};
    ledger[tfile] = { lastSyncedAt: Date.now(), lastSyncedPosition: 0, messageCount: lines[conv].length, conversationId: conv, sourceGeneration: { client: "claude", sessionId, dev: 0, ino: 0, birthtimeMs: 0, unit: "bytes", watermark: 0, prefixProven: true } };
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
  };
  edit(A, "src/a.ts", "export const a = 'still bad';\n");
  edit(A, ".env.local", "SECRET=sk-ant-REDACTEDREDACTEDREDACTEDREDACTED\n");
  edit(B, "src/b.ts", "export const b = 'still bad';\n");
  write(root, "notes.txt", "nobody's edit names this\n");
  write(root, "src/c.ts", "export const c = 1;\n");

  // Upstream moves on without the checkout fetching it.
  write(seed, "src/d.ts", "export const d = 2;\n");
  git(seed, "commit", "-qam", "upstream d");
  git(seed, "push", "-q", origin, "main");
  const fresh = git(origin, "rev-parse", "main");
  const shared = () => ({ head: git(root, "rev-parse", "HEAD"), status: git(root, "status", "--porcelain"), index: git(root, "ls-files", "-s") });
  return { root, origin, fresh, edit, shared };
}

describe("a shared checkout's pass is one flow change", () => {
  test("a commit per writer with its trailer, on fresh upstream; unattributed files ship, credentials and stale copies stay out", async () => {
    const { root, fresh, shared } = checkoutWorld();
    const before = shared();

    const preview = await previewCheckoutChange(root, { roster });
    expect(preview.groups.map((g) => [g.id, g.paths])).toEqual([["s:jx7aaaa", ["src/a.ts"]], ["s:jx7bbbb", ["src/b.ts"]], ["unattributed", ["notes.txt"]]]);
    expect(preview.held.map((h) => h.path).sort()).toEqual([".env.local", "src/c.ts"]);
    expect(preview.held.find((h) => h.path === "src/c.ts")!.why).toMatch(/^a stale copy/);

    const change = await freezeCheckoutChange(root, { branch: "codecast/pass", worktree: "pass", title: "Ship the checkout", roster });
    expect(change.source).toBe("checkout");
    expect(change.paths).toEqual(["notes.txt", "src/a.ts", "src/b.ts"]);
    expect(change.writers).toEqual({ "src/a.ts": { conversation: A, session: "jx7aaaa" }, "src/b.ts": { conversation: B, session: "jx7bbbb" } });
    expect(change.held.map((h) => h.path).sort()).toEqual([".env.local", "src/c.ts"]);

    // Three commits on the freshly fetched upstream, each a writer's (or the unattributed files'), with its trailer.
    expect(change.base).toBe(fresh);
    expect(change.behind).toBeUndefined();
    expect(git(root, "rev-parse", "codecast/pass")).toBe(change.tip);
    const commits = git(root, "log", "--reverse", "--format=%H", `${fresh}..${change.tip}`).split("\n");
    expect(commits).toHaveLength(3);
    const files = (sha: string) => git(root, "diff-tree", "-r", "--no-commit-id", "--name-only", sha);
    expect(commits.map(files)).toEqual(["src/a.ts", "src/b.ts", "notes.txt"]);
    const body = (sha: string) => git(root, "log", "-1", "--format=%B", sha);
    expect(body(commits[0])).toContain("feat(src): make a.ts good");
    expect(body(commits[0])).toContain(`Codecast-Session: `);
    expect(body(commits[0])).toContain(A);
    expect(body(commits[1])).toContain(B);
    expect(body(commits[2])).not.toContain("Codecast-Session");

    // Upstream's work is under it; the held files are not in it.
    expect(git(root, "show", `${change.tip}:src/d.ts`)).toBe("export const d = 2;");
    expect(git(root, "show", `${change.tip}:src/c.ts`)).toBe("export const c = 1;\nexport const c2 = 2;");
    expect(() => git(root, "cat-file", "-e", `${change.tip}:.env.local`)).toThrow();

    // Nothing in the shared tree moved.
    expect(shared()).toEqual(before);
  }, 180_000);

  test("a refreeze takes a writer's fix and a file it adds, and leaves a stranger's new file out", async () => {
    const { root, edit } = checkoutWorld();
    const change = await freezeCheckoutChange(root, { branch: "codecast/pass", worktree: "pass", roster });
    const runDir = path.join(root, ".git", "run-pass");
    writeFrozenChange(runDir, { ...change, session: "jx7cccc", conversation: "jx7ccccccccccccccccccccccccccccc" });
    edit(A, "src/a.ts", "export const a = 'good';\n");
    edit(A, "src/a.test.ts", "test a\n");
    write(root, "stranger.txt", "nobody wrote this\n");

    const { change: again, moved } = await refreezeSessionChange(root, runDir, null, { roster });
    expect(moved).toBe(true);
    expect(again.paths).toEqual(["notes.txt", "src/a.test.ts", "src/a.ts", "src/b.ts"]);
    expect(again.writers?.["src/a.test.ts"]).toEqual({ conversation: A, session: "jx7aaaa" });
    expect(git(root, "show", `${again.tip}:src/a.ts`)).toBe("export const a = 'good';");
    expect(again.branch).toBe("codecast/pass");
    // The session the run was started from stays its subject.
    expect(again.conversation).toBe("jx7ccccccccccccccccccccccccccccc");
    expect(readFrozenChange(runDir)?.tip).toBe(again.tip);
  }, 180_000);

  test("a refreeze after a brief keeps what a writer's shell made after it: a lockfile, a git mv target and its source", async () => {
    const { root, edit } = checkoutWorld();
    // A file of the checkout's own, committed here and not yet pushed: upstream never touched it, so its move replays.
    write(root, "src/f.ts", "export const f = 1;\n");
    git(root, "add", "src/f.ts");
    git(root, "commit", "-qm", "add f");
    const change = await freezeCheckoutChange(root, { branch: "codecast/pass", worktree: "pass", roster });
    const runDir = path.join(root, ".git", "run-pass");
    writeFrozenChange(runDir, change);
    write(root, "stranger.txt", "written before the brief\n");
    // ctime and mtime have whole-millisecond or coarser resolution: the brief goes out strictly after the stranger's write.
    const since = Date.now() + 5;
    await new Promise((r) => setTimeout(r, 20));
    edit(A, "src/a.ts", "export const a = 'good';\n");
    write(root, "bun.lock", "{ lockfile: 1 }\n");
    git(root, "mv", "src/f.ts", "src/e.ts");

    const { change: again } = await refreezeSessionChange(root, runDir, null, { roster, since });
    expect(again.paths).toEqual(["bun.lock", "notes.txt", "src/a.ts", "src/b.ts", "src/e.ts", "src/f.ts"]);
    expect(again.behind).toBeUndefined();
    expect(git(root, "show", `${again.tip}:bun.lock`)).toBe("{ lockfile: 1 }");
    expect(git(root, "show", `${again.tip}:src/e.ts`)).toBe("export const f = 1;");
    expect(() => git(root, "cat-file", "-e", `${again.tip}:src/f.ts`)).toThrow();
    expect(() => git(root, "cat-file", "-e", `${again.tip}:stranger.txt`)).toThrow();
    // Without a brief to date them by, unattributed newcomers stay out as before.
    writeFrozenChange(runDir, change);
    const { change: undated } = await refreezeSessionChange(root, runDir, null, { roster });
    expect(undated.paths).toEqual(["notes.txt", "src/a.ts", "src/b.ts"]);
  }, 180_000);

  test("a refreeze of a pass upstream already holds, the checkout levelled under it, comes back landed", async () => {
    const { root, origin } = checkoutWorld();
    const change = await freezeCheckoutChange(root, { branch: "codecast/pass", worktree: "pass", roster });
    const runDir = path.join(root, ".git", "run-pass");
    writeFrozenChange(runDir, change);
    // Another pass landed exactly these files, and the level sweep moved the checkout onto it.
    const other = path.join(path.dirname(root), "other");
    git(path.dirname(root), "clone", "-q", origin, other);
    for (const f of ["src/a.ts", "src/b.ts", "notes.txt"]) write(other, f, fs.readFileSync(path.join(root, f), "utf-8"));
    git(other, "add", "-A");
    git(other, "commit", "-qm", "the pass, landed elsewhere");
    git(other, "push", "-q", "origin", "main");
    git(root, "fetch", "-q", "origin");
    git(root, "reset", "-q", "--hard", "origin/main");

    const { change: again, moved } = await refreezeSessionChange(root, runDir, null, { roster });
    expect(moved).toBe(false);
    expect(again.landed).toBe(git(origin, "rev-parse", "main"));
    expect(again.tip).toBe(change.tip);
    expect(readFrozenChange(runDir)?.landed).toBe(again.landed);
  }, 180_000);

  test("a checkout with only held files has nothing to ship, and says what is held", async () => {
    const { root } = checkoutWorld();
    for (const f of ["src/a.ts", "src/b.ts"]) git(root, "checkout", "--", f);
    fs.rmSync(path.join(root, "notes.txt"));
    const refused = freezeCheckoutChange(root, { branch: "codecast/none", worktree: "none" });
    await expect(refused).rejects.toBeInstanceOf(NoCheckoutChange);
    await expect(refused).rejects.toThrow(/can ship \(held: .*\.env\.local/);
  }, 180_000);
});

// The session that ran `cast flow run --checkout`: the run's subject, which hears findings that name no file of the change.
const CALLER = "jx7cccccccccccccccccccccccccccc3";

/** The change flow with a check that reads the frozen branch and prints `$1` for each file that is not good yet. */
function changeFlow(check: string) {
  const dir = fs.mkdtempSync(path.join(sandbox, "flows-"));
  fs.writeFileSync(path.join(dir, "tcheck.cast"), `digraph tcheck {
    graph [kind="segment", label="Check"]
    start [shape=Mdiamond]
    verify [label="Verify", shape=parallelogram, script="${check.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]
    passed [shape=Msquare, label="Passed"]
    failed [shape=Msquare, label="Checks failed", stop="The project's check failed on the change: $verify.output"]
    start -> verify
    verify -> passed [condition="outcome = success"]
    verify -> failed [condition="outcome = failure"]
  }`);
  return parseWorkflowSource(`digraph change {
    graph [label="Change", on_failure=stop]
    start [shape=Mdiamond]
    check [flow="tcheck"]
    fix_check [label="Fix check", backend=subject, max_visits=3, prompt="Check failed on $task_id.\\n\\n$stop_reason"]
    exit [shape=Msquare, label="Done"]
    start -> check
    check -> exit
    check -> fix_check [condition="outcome = failure"]
    fix_check -> check
  }`, dir);
}
// Each file of the change whose content on the frozen branch does not say good is an error naming it.
const GOOD_CHECK = `bad=0; for f in src/a.ts src/b.ts; do git -C $project_path show $branch:$f | grep -q good || { echo error: $f is not good; bad=1; }; done; exit $bad`;

/** The server, playing every session: `fixes[conversation]` is what that session does when a brief reaches it; it reads working until that is done. */
function sessions(fixes: Record<string, () => void | Promise<void>>) {
  const calls: Array<{ route: string; body: any }> = [];
  const messages: Record<string, number> = { [A]: 10, [B]: 10, [CALLER]: 10 };
  const busy = new Set<string>();
  globalThis.fetch = (async (url: any, init: any) => {
    const route = String(url).replace(/^https?:\/\/[^/]+/, "");
    const body = JSON.parse(init?.body || "{}");
    calls.push({ route, body: structuredClone(body) });
    const reply = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (route === "/cli/inbox") return reply({ sessions: (body.session_ids ?? []).filter((id: string) => id in messages).map((id: string) => ({ id, work_state: busy.has(id) ? "working" : "done", is_live: true, is_killed: false, message_count: messages[id] })) });
    if (route === "/cli/messages/send") {
      const to: string = body.to;
      const fixing = /^Check failed/.test(body.body) ? fixes[to]?.() : undefined;
      if (fixing) {
        busy.add(to);
        void fixing.then(() => { messages[to] += 3; busy.delete(to); });
      } else messages[to] = (messages[to] ?? 0) + 3;
      return reply({ ok: true });
    }
    return reply({ ok: true });
  }) as typeof fetch;
  const briefs = () => calls.filter((c) => c.route === "/cli/messages/send" && /^Check failed/.test(c.body.body)).map((c) => c.body);
  return { calls, briefs };
}

async function runOnCheckout(root: string, graph: ReturnType<typeof changeFlow>) {
  const runDir = lineRunDir(root, runSlug(graph, { task_id: "ct-9" }, "run"));
  const change = await freezeCheckoutChange(root, { branch: "codecast/change-ct-9", worktree: "change-ct-9", roster });
  writeFrozenChange(runDir, { ...change, session: CALLER.slice(0, 7), conversation: CALLER });
  console.log = process.env.SHOW_RUN ? origLog : () => {};
  try {
    const outcome = await runWorkflow(graph, { cwd: root, taskId: "ct-9", runId: "run-9", runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1, subjectParkMs: 1 });
    return { outcome, runDir };
  } finally {
    console.log = origLog;
  }
}

describe("a finding goes to the writers of the files it names", () => {
  const parked = (s: ReturnType<typeof sessions>) => s.calls.filter((c) => ["/cli/sessions/dismiss", "/cli/sessions/hibernate", "/cli/sessions/retire", "/cli/sessions/kill"].includes(c.route));

  test("a check naming one writer's file briefs only that writer, quietly; its fix is frozen in and Check passes", async () => {
    const { root, edit } = checkoutWorld();
    edit(B, "src/b.ts", "export const b = 'good';\n");
    const s = sessions({ [A]: () => edit(A, "src/a.ts", "export const a = 'good';\n") });
    const { outcome, runDir } = await runOnCheckout(root, changeFlow(GOOD_CHECK));
    expect(outcome).toBe("completed");
    const briefs = s.briefs();
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toMatchObject({ to: A, from: "conv_run", quiet: true });
    expect(briefs[0].body).toContain("error: src/a.ts is not good");
    expect(briefs[0].body).toContain("Your files among the failing ones: src/a.ts.");
    expect(git(root, "show", "codecast/change-ct-9:src/a.ts")).toBe("export const a = 'good';");
    expect(readFrozenChange(runDir)?.tip).toBe(git(root, "rev-parse", "codecast/change-ct-9"));
    // The station says who it briefed; nobody is parked or retired.
    const fixed = s.calls.find((c) => c.route === "/cli/workflow-runs/progress" && c.body.node_id === "fix_check" && c.body.node_status === "completed");
    expect(fixed?.body.result_preview ?? "").toContain("briefed jx7aaaa (src/a.ts)");
    expect(parked(s)).toEqual([]);
  }, 1_200_000);

  test("a check naming both writers' files briefs both, each with its own file, and waits for both", async () => {
    const { root, edit } = checkoutWorld();
    const s = sessions({
      [A]: () => edit(A, "src/a.ts", "export const a = 'good';\n"),
      // B works a while longer: the run must not freeze the pass before B has settled.
      [B]: () => new Promise<void>((done) => setTimeout(() => { edit(B, "src/b.ts", "export const b = 'good';\n"); done(); }, 1500)),
    });
    const { outcome } = await runOnCheckout(root, changeFlow(GOOD_CHECK));
    expect(outcome).toBe("completed");
    const briefs = s.briefs();
    // One brief each: a freeze before B settled would fail Check again and brief B twice.
    expect(briefs.map((b) => b.to).sort()).toEqual([A, B]);
    expect(briefs.find((b) => b.to === A)!.body).toContain("Your files among the failing ones: src/a.ts.");
    expect(briefs.find((b) => b.to === B)!.body).toContain("Your files among the failing ones: src/b.ts.");
    expect(git(root, "show", "codecast/change-ct-9:src/b.ts")).toBe("export const b = 'good';");
    expect(parked(s)).toEqual([]);
  }, 1_200_000);

  test("a finding that names no file of the change goes to the session that ran the run", async () => {
    const { root } = checkoutWorld();
    const s = sessions({ [CALLER]: () => write(root, "notes.txt", "fixed\n") });
    const { outcome } = await runOnCheckout(root, changeFlow(`[ "$(git -C $project_path show $branch:notes.txt)" = fixed ] || { echo error: the lint config is broken; exit 1; }`));
    expect(outcome).toBe("completed");
    const briefs = s.briefs();
    expect(briefs.map((b) => b.to)).toEqual([CALLER]);
    expect(briefs[0].body).not.toContain("Your files among the failing ones");
    expect(git(root, "show", "codecast/change-ct-9:notes.txt")).toBe("fixed");
    expect(parked(s)).toEqual([]);
  }, 1_200_000);
});

type Row = { work_state: string; message_count: number; pin?: { status: string; state: string; at: number } };
type Ctl = { row: (id: string) => Row; deliver: (id: string) => void; settle: (id: string, pin?: { status: string; state: string }, grow?: number) => void };

/**
 * A server whose sessions each play a script when a brief reaches them, with the brief's delivery read the way
 * /cli/messages/status reports it. `briefed[conversation]` runs on its brief; `unreadable` sessions are missing from
 * every read; a send to `refuse` fails.
 */
function scripted(briefed: Record<string, (ctl: Ctl) => void>, opts: { busy?: string[]; unreadable?: string[]; refuse?: string[] } = {}) {
  const calls: Array<{ route: string; body: any }> = [];
  const rows: Record<string, Row> = Object.fromEntries([A, B, CALLER].map((id) => [id, { work_state: opts.busy?.includes(id) ? "working" : "done", message_count: 10 }]));
  const sends: Record<string, Array<{ created_at: number; status: string; delivered_at?: number }>> = {};
  const ctl: Ctl = {
    row: (id) => rows[id],
    deliver: (id) => { const s = sends[id]?.at(-1); if (s) Object.assign(s, { status: "delivered", delivered_at: Date.now() }); rows[id].message_count += 1; },
    settle: (id, pin, grow = 2) => { rows[id].message_count += grow; rows[id].work_state = "done"; if (pin) rows[id].pin = { ...pin, at: Date.now() }; },
  };
  globalThis.fetch = (async (url: any, init: any) => {
    const route = String(url).replace(/^https?:\/\/[^/]+/, "");
    const body = JSON.parse(init?.body || "{}");
    calls.push({ route, body: structuredClone(body) });
    const reply = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (route === "/cli/inbox") return reply({ sessions: (body.session_ids ?? []).filter((id: string) => id in rows && !opts.unreadable?.includes(id)).map((id: string) => ({ id, is_live: true, is_killed: false, ...rows[id] })) });
    if (route === "/cli/sessions/state/get") return reply(rows[body.session]?.pin ?? {});
    if (route === "/cli/messages/status") return reply({ to_short_id: String(body.to).slice(0, 7), sends: [...(sends[body.to] ?? [])].reverse() });
    if (route === "/cli/messages/send") {
      if (opts.refuse?.includes(body.to)) return reply({ error: "refused" });
      (sends[body.to] ??= []).push({ created_at: Date.now(), status: "pending" });
      if (/^Check failed/.test(body.body)) briefed[body.to]?.(ctl);
      return reply({ ok: true, message_id: `m${calls.length}` });
    }
    return reply({ ok: true });
  }) as typeof fetch;
  const sent = (to?: string) => calls.filter((c) => c.route === "/cli/messages/send" && (!to || c.body.to === to)).map((c) => c.body);
  const briefs = (to?: string) => sent(to).filter((b) => /^Check failed/.test(b.body));
  return { calls, sent, briefs };
}

/** A writer that takes its brief at once, works, makes `fix` and settles. */
const fixes = (id: string, fix: () => void) => (ctl: Ctl) => {
  ctl.deliver(id);
  ctl.row(id).work_state = "working";
  setTimeout(() => { fix(); ctl.settle(id, { status: "done", state: "fixed" }); }, 50);
};

async function runOn(root: string, graph: ReturnType<typeof changeFlow>, caller = true) {
  const runDir = lineRunDir(root, runSlug(graph, { task_id: "ct-9" }, "run"));
  const change = await freezeCheckoutChange(root, { branch: "codecast/change-ct-9", worktree: "change-ct-9", roster });
  writeFrozenChange(runDir, caller ? { ...change, session: CALLER.slice(0, 7), conversation: CALLER } : change);
  console.log = process.env.SHOW_RUN ? origLog : () => {};
  try {
    return await runWorkflow(graph, { cwd: root, taskId: "ct-9", runId: "run-9", runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1, subjectParkMs: 1 });
  } finally {
    console.log = origLog;
  }
}
const progressSaid = (s: ReturnType<typeof scripted>) => s.calls.filter((c) => c.route === "/cli/workflow-runs/progress").map((c) => `${c.body.result_preview ?? ""} ${c.body.fail_reason ?? ""}`).join("\n");

describe("writers answer for themselves", () => {
  test("a writer mid-turn when briefed answers only with a turn after the brief reached it", async () => {
    const { root, edit } = checkoutWorld();
    edit(B, "src/b.ts", "export const b = 'good';\n");
    const s = scripted({
      [A]: (ctl) => {
        // Its own turn ends first, pinning after the brief went out; the brief lands only then, and A fixes a.ts.
        setTimeout(() => ctl.settle(A, { status: "done", state: "finished my own thing" }), 300);
        setTimeout(() => { ctl.deliver(A); ctl.row(A).work_state = "working"; }, 900);
        setTimeout(() => { edit(A, "src/a.ts", "export const a = 'good';\n"); ctl.settle(A, { status: "done", state: "fixed a.ts" }); }, 1200);
      },
    }, { busy: [A] });
    expect(await runOn(root, changeFlow(GOOD_CHECK))).toBe("completed");
    // A freeze at the end of A's own turn would fail Check again and brief A a second time.
    expect(s.briefs(A)).toHaveLength(1);
    expect(git(root, "show", "codecast/change-ct-9:src/a.ts")).toBe("export const a = 'good';");
  }, 1_200_000);

  test("a writer that blocks stops the run with its ask, without waiting out a writer that never answers", async () => {
    const { root } = checkoutWorld();
    const ask = "Which config should src/a.ts read, the old one or the new one?";
    const s = scripted({
      [A]: (ctl) => { ctl.deliver(A); ctl.row(A).work_state = "working"; setTimeout(() => ctl.settle(A, { status: "blocked", state: ask }), 200); },
      // B takes its brief and works on, never answering.
      [B]: (ctl) => { ctl.deliver(B); ctl.row(B).work_state = "working"; },
    });
    expect(await runOn(root, changeFlow(GOOD_CHECK))).toBe("failed");
    expect(progressSaid(s)).toContain("fix_check is waiting on a person");
    expect(JSON.stringify(s.calls)).toContain(ask);
    expect(progressSaid(s)).not.toContain("killed after");
    // B hears the run no longer waits on it; A, who asked, is not told so.
    expect(s.sent(B).filter((m) => /no longer waits on the brief/.test(m.body))).toHaveLength(1);
    expect(s.sent(A).filter((m) => /no longer waits on the brief/.test(m.body))).toHaveLength(0);
  }, 1_200_000);

  test("files no session wrote go to the session that ran the pass, beside the writer's own", async () => {
    const { root, edit } = checkoutWorld();
    edit(B, "src/b.ts", "export const b = 'good';\n");
    const check = `${GOOD_CHECK.replace(/; exit \$bad$/, "")}; [ "$(git -C $project_path show $branch:notes.txt)" = fixed ] || { echo error: notes.txt is not fixed; bad=1; }; exit $bad`;
    const s = scripted({
      [A]: fixes(A, () => edit(A, "src/a.ts", "export const a = 'good';\n")),
      [CALLER]: fixes(CALLER, () => write(root, "notes.txt", "fixed\n")),
    });
    expect(await runOn(root, changeFlow(check))).toBe("completed");
    expect(s.briefs(A)).toHaveLength(1);
    expect(s.briefs(A)[0].body).toContain("Your files among the failing ones: src/a.ts.");
    expect(s.briefs(A)[0].body).not.toContain("notes.txt is yours");
    expect(s.briefs(CALLER)).toHaveLength(1);
    expect(s.briefs(CALLER)[0].body).toContain("yours to fix or hand to whoever wrote them: notes.txt.");
    expect(s.briefs(CALLER)[0].body).not.toContain("Your files among the failing ones");
    expect(git(root, "show", "codecast/change-ct-9:notes.txt")).toBe("fixed");
  }, 1_200_000);

  test("with nobody to tell about them, the station says the unclaimed files went unheard", async () => {
    const { root, edit } = checkoutWorld();
    edit(B, "src/b.ts", "export const b = 'good';\n");
    const check = `${GOOD_CHECK.replace(/; exit \$bad$/, "")}; [ "$(git -C $project_path show $branch:notes.txt)" = fixed ] || { echo error: notes.txt is not fixed; bad=1; }; exit $bad`;
    const s = scripted({ [A]: fixes(A, () => edit(A, "src/a.ts", "export const a = 'good';\n")) });
    expect(await runOn(root, changeFlow(check), false)).toBe("failed");
    expect(s.briefs(A)).toHaveLength(1);
    expect(progressSaid(s)).toContain("No session's edit names notes.txt, which the finding also names, and this run has no session of its own to tell");
  }, 1_200_000);

  test("every writer's row is read before any brief goes", async () => {
    const { root } = checkoutWorld();
    const s = scripted({}, { unreadable: [B] });
    expect(await runOn(root, changeFlow(GOOD_CHECK))).toBe("failed");
    expect(s.briefs()).toHaveLength(0);
    expect(progressSaid(s)).toContain("jx7bbbb, who wrote src/b.ts, cannot be read");
  }, 1_200_000);

  test("a brief that cannot be sent partway tells the writers already briefed that the run stopped", async () => {
    const { root } = checkoutWorld();
    const s = scripted({ [A]: (ctl) => { ctl.deliver(A); ctl.row(A).work_state = "working"; } }, { refuse: [B] });
    expect(await runOn(root, changeFlow(GOOD_CHECK))).toBe("failed");
    expect(s.briefs(A)).toHaveLength(1);
    const off = s.sent(A).filter((m) => /no longer waits on the brief/.test(m.body));
    expect(off).toHaveLength(1);
    expect(off[0]).toMatchObject({ quiet: true, client_id: expect.stringMatching(/^run:run-9:fix_check:jx7aaaa:off:/) });
    expect(off[0].body).toContain("the brief to jx7bbbb could not be sent");
  }, 1_200_000);
});
