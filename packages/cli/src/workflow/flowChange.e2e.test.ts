// End to end (flows.md FL4): a session's change in a shared checkout, made
// partly with the Edit tool and partly through Bash (sed -i, a python
// heredoc, a cat redirect), beside another session's work, frozen into a
// commit of its own and run through a flow. Real git, fake transcripts in an
// isolated CODECAST_DIR and HOME. The worst failure here is a run that
// silently leaves out some of the session's edits.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { freezeSessionChange, frozenChangeContext, writeFrozenChange } from "./flowChange";
import { parseWorkflowSource } from "./parser";
import { lineRunDir, runSlug, runWorkflow } from "./runner";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
const saved: Record<string, string | undefined> = {};
let sandbox = "";

beforeAll(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-flow-e2e-")));
  for (const [k, v] of Object.entries({ ...ENV, HOME: sandbox, CODECAST_DIR: path.join(sandbox, ".codecast") })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, ...ENV } }).replace(/\n$/, "");
const write = (dir: string, file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };

function transcript(sessionId: string, conversationId: string, lines: object[]) {
  const dir = path.join(sandbox, ".claude", "projects", "-sandbox");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const ledgerFile = path.join(process.env.CODECAST_DIR!, "sync-ledger.json");
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, "utf-8")) : {};
  ledger[file] = { lastSyncedAt: Date.now(), lastSyncedPosition: 0, messageCount: lines.length, conversationId, sourceGeneration: { client: "claude", sessionId, dev: 0, ino: 0, birthtimeMs: 0, unit: "bytes", watermark: 0, prefixProven: true } };
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
}
const at = (ms: number) => new Date(Date.now() - ms).toISOString();
const tool = (cwd: string, name: string, input: object, ms: number) => ({ type: "assistant", timestamp: at(ms), cwd, message: { role: "assistant", content: [{ type: "tool_use", id: `t${Math.random()}`, name, input }] } });

describe("a session's change runs through a flow", () => {
  test("every file the session wrote, by Edit or by Bash, is in the frozen commit; others' files and credentials stay out", async () => {
    const root = path.join(sandbox, "shared");
    fs.mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    for (const [f, t] of Object.entries({ "src/api.ts": "export const api = 1;\n", "src/util.ts": "export const u = 1;\n", "src/page.tsx": "export const page = 1;\n", "src/both.ts": "export const both = 1;\n", "docs/notes.md": "# notes\n" })) write(root, f, t);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "base");

    // Session A: one Edit, then Bash for the rest.
    write(root, "src/api.ts", "export const api = 2;\n");
    write(root, "src/util.ts", "export const u = 2;\n");
    write(root, "src/new-helper.ts", "export const helper = 1;\n");
    write(root, "docs/notes.md", "# notes\n\nA line written by a heredoc.\n");
    write(root, "src/both.ts", "export const both = 2; // A\nexport const alsoB = 1; // B\n");
    write(root, ".env.local", "SECRET=sk-ant-REDACTEDREDACTEDREDACTEDREDACTED\n");
    // Session B: its own page, and a later line in the file A also changed.
    write(root, "src/page.tsx", "export const page = 2;\n");
    transcript("sess-a", "jx7aaaaaaaaaaaaaaaaaaaaaaaaaaaaa", [
      tool(root, "Edit", { file_path: path.join(root, "src/api.ts"), old_string: "1", new_string: "2" }, 90_000),
      tool(root, "Bash", { command: `cd ${root}/src && sed -i '' 's/u = 1/u = 2/' util.ts` }, 80_000),
      tool(root, "Bash", { command: `cat > src/new-helper.ts <<'EOF'\nexport const helper = 1;\nEOF` }, 70_000),
      tool(root, "Bash", { command: `cd ${root} && python3 - <<'EOF'\np='docs/notes.md'\nopen(p,'a').write('A line written by a heredoc.')\nEOF` }, 60_000),
      tool(root, "Edit", { file_path: path.join(root, "src/both.ts"), old_string: "1", new_string: "2" }, 50_000),
      tool(root, "Bash", { command: `printf 'SECRET=x' > .env.local` }, 45_000),
    ]);
    transcript("sess-b", "jx7bbbbbbbbbbbbbbbbbbbbbbbbbbbbb", [
      tool(root, "Edit", { file_path: path.join(root, "src/page.tsx"), old_string: "1", new_string: "2" }, 40_000),
      tool(root, "Edit", { file_path: path.join(root, "src/both.ts"), old_string: "", new_string: "export const alsoB = 1;" }, 30_000),
    ]);
    const statusBefore = git(root, "status", "--porcelain");
    const headBefore = git(root, "rev-parse", "HEAD");

    const change = await freezeSessionChange(root, "jx7aaaa", { branch: "codecast/change-ct-1", worktree: "change-ct-1", title: "Speed up the api" });

    // All five of A's files, though B wrote both.ts last; B's page and the credential stay out.
    expect(change.paths).toEqual(["docs/notes.md", "src/api.ts", "src/both.ts", "src/new-helper.ts", "src/util.ts"]);
    expect(change.shared).toEqual([{ path: "src/both.ts", also: ["jx7bbbb"] }]);
    expect(change.paths).not.toContain(".env.local");
    expect(change.session).toBe("jx7aaaa");

    // The commit holds exactly that content, on its own branch, on top of HEAD.
    expect(git(root, "rev-parse", "codecast/change-ct-1")).toBe(change.tip);
    expect(git(root, "rev-parse", `${change.tip}^`)).toBe(headBefore);
    expect(git(root, "diff", "--name-only", headBefore, change.tip).split("\n").sort()).toEqual(change.paths);
    expect(git(root, "show", `${change.tip}:src/util.ts`)).toBe("export const u = 2;");
    expect(git(root, "show", `${change.tip}:docs/notes.md`)).toContain("A line written by a heredoc.");
    expect(git(root, "show", `${change.tip}:src/new-helper.ts`)).toBe("export const helper = 1;");
    expect(git(root, "show", `${change.tip}:src/page.tsx`)).toBe("export const page = 1;");
    expect(() => git(root, "cat-file", "-e", `${change.tip}:.env.local`)).toThrow();
    expect(git(root, "log", "-1", "--format=%s", change.tip)).toBe("feat(src): speed up the api");

    // Nothing in the shared tree moved.
    expect(git(root, "status", "--porcelain")).toBe(statusBefore);
    expect(git(root, "rev-parse", "HEAD")).toBe(headBefore);

    // The run starts on the change: its stations read $branch and $worktree from the run's files.
    const flow = parseWorkflowSource(`digraph change {
      start [shape=Mdiamond]
      look [label="Look", shape=parallelogram, script="git -C $project_path show --stat --format=%s $branch > $run_dir/seen.txt && echo $worktree >> $run_dir/seen.txt"]
      done [shape=Msquare]
      start -> look -> done
    }`);
    const runDir = lineRunDir(root, runSlug(flow, { task_id: "ct-1" }, "run"));
    writeFrozenChange(runDir, change);
    expect(frozenChangeContext(runDir)).toMatchObject({ branch: "codecast/change-ct-1", worktree: "change-ct-1", change_session: "jx7aaaa" });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(" "));
    try {
      expect(await runWorkflow(flow, { cwd: root, taskId: "ct-1" })).toBe("completed");
    } finally {
      console.log = orig;
    }
    const seen = fs.readFileSync(path.join(runDir, "seen.txt"), "utf-8");
    expect(seen).toContain("feat(src): speed up the api");
    for (const p of change.paths) expect(seen).toContain(p);
    expect(seen.trim().endsWith("change-ct-1")).toBe(true);
  }, 60_000);

  test("a session with nothing changed here says so", async () => {
    const root = path.join(sandbox, "quiet");
    fs.mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    write(root, "a.txt", "a\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "base");
    write(root, "a.txt", "b\n");
    transcript("sess-c", "jx7ccccccccccccccccccccccccccccc", [tool(root, "Edit", { file_path: path.join(root, "a.txt"), old_string: "a", new_string: "b" }, 10_000)]);
    await expect(freezeSessionChange(root, "jx7zzzz", { branch: "codecast/x", worktree: "x" })).rejects.toThrow(/No uncommitted change/);
  });
});
