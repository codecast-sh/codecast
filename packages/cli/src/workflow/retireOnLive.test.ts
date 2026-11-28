// The daemon's half of a retire on live (retireOnLive.ts): a real git checkout
// with an origin, fake transcripts in an isolated CODECAST_DIR and HOME, and a
// fake server. It retires only a session whose checkout holds nothing of its
// own beside what landed; anything else keeps it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { retireOnLive } from "./retireOnLive";

// Each case builds a repo, an origin and pushes with real git: the 5s default times out under load.
setDefaultTimeout(30_000);

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
const saved: Record<string, string | undefined> = {};
let sandbox = "";

beforeAll(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-retire-live-")));
  for (const [k, v] of Object.entries({ ...ENV, HOME: sandbox, CODECAST_DIR: path.join(sandbox, ".codecast") })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// Commits are an hour old, so the transcripts' writes (seconds ago) come after them.
const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, ...ENV, GIT_AUTHOR_DATE: HOUR_AGO, GIT_COMMITTER_DATE: HOUR_AGO } }).replace(/\n$/, "");
const write = (dir: string, file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };

const CONV = "jx7aaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
let worlds = 0;

function transcript(sessionId: string, conversationId: string, lines: object[]) {
  const dir = path.join(sandbox, ".claude", "projects", "-sandbox");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}-${worlds}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const ledgerFile = path.join(process.env.CODECAST_DIR!, "sync-ledger.json");
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, "utf-8")) : {};
  ledger[file] = { lastSyncedAt: Date.now(), lastSyncedPosition: 0, messageCount: lines.length, conversationId, sourceGeneration: { client: "claude", sessionId, dev: 0, ino: 0, birthtimeMs: 0, unit: "bytes", watermark: 0, prefixProven: true } };
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
}
const at = (ms: number) => new Date(Date.now() - ms).toISOString();
const tool = (cwd: string, name: string, input: object, ms: number) => ({ type: "assistant", timestamp: at(ms), cwd, message: { role: "assistant", content: [{ type: "tool_use", id: `t${Math.random()}`, name, input }] } });

/** A checkout whose session's Edit of src/api.ts landed on origin/main; returns it and the landed sha. */
function landedWorld(): { root: string; landed: string } {
  process.env.CODECAST_DIR = path.join(sandbox, `.codecast-${++worlds}`);
  const origin = path.join(sandbox, `origin-${worlds}.git`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const root = path.join(sandbox, `app-${worlds}`);
  fs.mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  write(root, "src/api.ts", "export const api = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "-q", "origin", "main");
  write(root, "src/api.ts", "export const api = 2;\n");
  transcript("sess-a", CONV, [tool(root, "Edit", { file_path: path.join(root, "src/api.ts"), old_string: "1", new_string: "2" }, 90_000)]);
  git(root, "commit", "-qam", "api 2");
  git(root, "push", "-q", "origin", "main");
  git(root, "fetch", "-q", "origin");
  return { root, landed: git(root, "rev-parse", "HEAD") };
}

/** The server as the daemon reads it: the session's inbox row, and the retire it asks for. */
function server(row: Record<string, unknown> = {}) {
  const retires: any[] = [];
  const call = async (route: string, body: Record<string, unknown>) => {
    if (route === "/cli/inbox") return { sessions: [{ id: CONV, short_id: "jx7aaaa", work_state: "done", is_killed: false, message_count: 7, last_person_turn_at: Date.now() - 200_000, ...row }] };
    if (route === "/cli/sessions/retire") { retires.push(structuredClone(body)); return { retired: true, short_id: "jx7aaaa" }; }
    throw new Error(`unplanned route ${route}`);
  };
  return { call, retires };
}

const SINCE = Date.now() - 90_000;
/** No pane and no agent process on this machine: nobody can be watching it. */
const detached = { terminalOf: async () => ({ pane: null, running: false }), tmuxSessions: async () => new Map<string, number>() };

describe("a daemon asked to retire a session whose change is live", () => {
  test("its checkout holds nothing of its own beside what landed: retired, at the transcript length it read", async () => {
    const { root, landed } = landedWorld();
    const s = server();
    expect(await retireOnLive(s.call, { conversation_id: CONV, root, since: SINCE, commits: [{ sha: landed }] }, detached)).toEqual({ retired: true });
    expect(s.retires).toEqual([{ session: CONV, expected_message_count: 7 }]);
  });

  test("work it wrote through Bash and never committed keeps it", async () => {
    const { root, landed } = landedWorld();
    write(root, "src/extra.ts", "export const extra = 1;\n");
    transcript("sess-a", CONV, [
      tool(root, "Edit", { file_path: path.join(root, "src/api.ts"), old_string: "1", new_string: "2" }, 90_000),
      tool(root, "Bash", { command: `cat > src/extra.ts <<'EOF'\nexport const extra = 1;\nEOF` }, 30_000),
    ]);
    const s = server();
    expect(await retireOnLive(s.call, { conversation_id: CONV, root, since: SINCE, commits: [{ sha: landed }] }, detached)).toEqual({ retired: false, reason: "it has other changes: src/extra.ts" });
    expect(s.retires).toEqual([]);
  });

  test("a later edit it committed locally and never pushed keeps it", async () => {
    const { root, landed } = landedWorld();
    write(root, "src/api.ts", "export const api = 3;\n");
    transcript("sess-a", CONV, [
      tool(root, "Edit", { file_path: path.join(root, "src/api.ts"), old_string: "1", new_string: "2" }, 90_000),
      tool(root, "Edit", { file_path: path.join(root, "src/api.ts"), old_string: "2", new_string: "3" }, 20_000),
    ]);
    git(root, "commit", "-qam", "api 3, local only");
    const s = server();
    expect(await retireOnLive(s.call, { conversation_id: CONV, root, since: SINCE, commits: [{ sha: landed }] }, detached)).toEqual({ retired: false, reason: "it has commits origin/main lacks: src/api.ts" });
    expect(s.retires).toEqual([]);
  });

  test("local commits whose content main already holds (they landed as a squash) do not keep it", async () => {
    const { root } = landedWorld();
    write(root, "src/api.ts", "export const api = 3;\n");
    git(root, "commit", "-qam", "api 3");
    write(root, "src/api.ts", "export const api = 4;\n");
    git(root, "commit", "-qam", "api 4");
    const other = path.join(sandbox, `squash-${worlds}`);
    execFileSync("git", ["clone", "-q", git(root, "remote", "get-url", "origin"), other]);
    write(other, "src/api.ts", "export const api = 4;\n");
    git(other, "commit", "-qam", "api 4 (squash)");
    git(other, "push", "-q", "origin", "main");
    git(root, "fetch", "-q", "origin");
    const squash = git(root, "rev-parse", "origin/main");
    const s = server();
    expect(await retireOnLive(s.call, { conversation_id: CONV, root, since: SINCE, commits: [{ sha: squash }] }, detached)).toEqual({ retired: true });
  });

  test("a changed file no session's edits account for (a script's output) keeps it", async () => {
    const { root, landed } = landedWorld();
    write(root, "src/generated.ts", "export const g = 1;\n");
    const s = server();
    expect(await retireOnLive(s.call, { conversation_id: CONV, root, since: SINCE, commits: [{ sha: landed }] }, detached)).toEqual({ retired: false, reason: "its checkout has changes no session's edits account for: src/generated.ts" });
    expect(s.retires).toEqual([]);
  });

  test("a person wrote to it after its own work, or it is not done, or its checkout is elsewhere: kept", async () => {
    const { root, landed } = landedWorld();
    const ask = { conversation_id: CONV, root, since: SINCE, commits: [{ sha: landed }] };
    const wrote = server({ last_person_turn_at: Date.now() - 10_000 });
    expect(await retireOnLive(wrote.call, ask, detached)).toEqual({ retired: false, reason: "a person wrote to it after its own work" });
    const dormant = server({ work_state: "dormant" });
    expect(await retireOnLive(dormant.call, ask, detached)).toEqual({ retired: false, reason: "it is not done (dormant)" });
    const elsewhere = server();
    expect(await retireOnLive(elsewhere.call, { ...ask, root: path.join(sandbox, "not-here") }, detached)).toEqual({ retired: false, reason: "its checkout is not on this machine" });
    expect([...wrote.retires, ...dormant.retires, ...elsewhere.retires]).toEqual([]);
  });

  test("a person attached to its tmux session keeps it; an unreadable terminal keeps it; a detached pane is retired", async () => {
    const { root, landed } = landedWorld();
    const ask = { conversation_id: CONV, root, since: SINCE, commits: [{ sha: landed }] };
    const panes: string[] = [];
    const terminal = (clients: number | undefined) => ({
      terminalOf: async (id: string) => { panes.push(id); return { pane: "cc-jx7aaaa:0.0", running: true }; },
      tmuxSessions: async () => new Map(clients === undefined ? [] : [["cc-jx7aaaa", clients]]),
    });
    const watching = server();
    expect(await retireOnLive(watching.call, ask, terminal(1))).toEqual({ retired: false, reason: "a person has its terminal open" });
    const gone = server();
    expect(await retireOnLive(gone.call, ask, terminal(undefined))).toEqual({ retired: false, reason: "its terminal could not be read" });
    const broken = server();
    expect(await retireOnLive(broken.call, ask, { terminalOf: async () => ({ pane: "cc-jx7aaaa:0.0", running: true }), tmuxSessions: async () => { throw new Error("no server"); } })).toEqual({ retired: false, reason: "its terminal could not be read" });
    expect([...watching.retires, ...gone.retires, ...broken.retires]).toEqual([]);
    const idle = server();
    expect(await retireOnLive(idle.call, ask, terminal(0))).toEqual({ retired: true });
    expect(idle.retires).toEqual([{ session: CONV, expected_message_count: 7 }]);
    expect(panes.every((id) => id === CONV)).toBe(true);
  });

  test("a live agent outside any tmux pane (a plain terminal window) keeps it, as does one this machine cannot look up; no process at all is retired", async () => {
    const { root, landed } = landedWorld();
    const ask = { conversation_id: CONV, root, since: SINCE, commits: [{ sha: landed }] };
    const unpaned = (running: boolean | null) => ({ terminalOf: async () => ({ pane: null, running }), tmuxSessions: async () => new Map<string, number>() });
    const windowed = server();
    expect(await retireOnLive(windowed.call, ask, unpaned(true))).toEqual({ retired: false, reason: "it runs outside a pane this machine can watch" });
    const unknown = server();
    expect(await retireOnLive(unknown.call, ask, unpaned(null))).toEqual({ retired: false, reason: "its agent process could not be looked up" });
    expect([...windowed.retires, ...unknown.retires]).toEqual([]);
    const ended = server();
    expect(await retireOnLive(ended.call, ask, unpaned(false))).toEqual({ retired: true });
    expect(ended.retires).toEqual([{ session: CONV, expected_message_count: 7 }]);
  });
});
