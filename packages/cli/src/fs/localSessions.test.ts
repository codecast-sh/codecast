// The Sync page's view of this machine before anything uploads: sessions per
// folder, folded into the checkout root the server keys rows by, with the
// count the current sync scope lets through.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { checkoutOf, summarizeLocalSessions } from "./localSessions";
import { isProjectAllowedToSync } from "../syncScope";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "local-sessions-"));
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const repo = path.join(home, "src", "app");
const worktree = path.join(home, ".codex", "worktrees", "a1b2", "app");
const notes = path.join(home, "notes", "health");
fs.mkdirSync(path.join(repo, ".git", "worktrees", "wt"), { recursive: true });
fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
// A stray .git folder (hooks and info only) inside the checkout is not a repository.
fs.mkdirSync(path.join(repo, "outreach", ".git", "hooks"), { recursive: true });
fs.writeFileSync(path.join(repo, ".git", "config"), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:acme/app.git\n');
fs.mkdirSync(worktree, { recursive: true });
fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${repo}/.git/worktrees/wt\n`);
fs.mkdirSync(path.join(repo, "packages", "web"), { recursive: true });
fs.mkdirSync(notes, { recursive: true });

function claude(dirName: string, id: string, cwd: string, mtime: number) {
  const dir = path.join(home, ".claude", "projects", dirName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: "user", cwd, sessionId: id, message: { role: "user", content: "hi" } }) + "\n");
  fs.utimesSync(file, mtime / 1000, mtime / 1000);
}
function codex(id: string, cwd: string, mtime: number) {
  const dir = path.join(home, ".codex", "sessions", "2026", "09", "23");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-23T10-00-00-${id}.jsonl`);
  // The meta line carries long base instructions, past one read chunk.
  fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id, cwd, base_instructions: { text: "x".repeat(90_000) } } }) + "\n");
  fs.utimesSync(file, mtime / 1000, mtime / 1000);
}

const T = Date.parse("2026-09-01T00:00:00Z");
claude("-src-app", "11111111-1111-4111-8111-111111111111", repo, T);
claude("-src-app-packages-web", "22222222-2222-4222-8222-222222222222", path.join(repo, "packages", "web"), T + 5_000);
claude("-notes-health", "33333333-3333-4333-8333-333333333333", notes, T + 10_000);
codex("44444444-4444-4444-8444-444444444444", worktree, T + 20_000);

describe("checkoutOf", () => {
  test("a subfolder and a linked worktree fold into the checkout, with its repository", () => {
    expect(checkoutOf(path.join(repo, "packages", "web"))).toEqual({ root: repo, repository: "acme/app", exists: true, git: true });
    expect(checkoutOf(worktree).root).toBe(repo);
    expect(checkoutOf(path.join(repo, "outreach")).root).toBe(repo);
    expect(checkoutOf(notes)).toEqual({ root: notes, exists: true, git: false });
  });
});

describe("summarizeLocalSessions", () => {
  test("counts Claude and Codex sessions per checkout, with dates", async () => {
    const { folders } = await summarizeLocalSessions(null, home);
    const app = folders.find((f) => f.path === repo)!;
    expect(app).toMatchObject({ repository: "acme/app", sessions: 3, claude: 2, codex: 1, synced: 3 });
    expect(app.first).toBe(T);
    expect(app.last).toBe(T + 20_000);
    expect(app.times).toEqual([T + 20_000, T + 5_000, T]);
    expect(folders.find((f) => f.path === notes)).toMatchObject({ sessions: 1, claude: 1, codex: 0 });
    expect(folders[0].path).toBe(repo);
  });

  test("synced counts follow the chosen folders", async () => {
    const { folders } = await summarizeLocalSessions({ sync_mode: "selected", sync_projects: [repo] } as any, home);
    expect(folders.find((f) => f.path === repo)!.synced).toBe(3);
    expect(folders.find((f) => f.path === notes)!.synced).toBe(0);
  });
});

describe("isProjectAllowedToSync reaches a checkout's worktrees", () => {
  test("a Codex worktree outside the chosen checkout syncs with it; an unrelated folder does not", () => {
    const config = { sync_mode: "selected", sync_projects: [repo] } as any;
    expect(isProjectAllowedToSync(worktree, config)).toBe(true);
    expect(isProjectAllowedToSync(path.join(repo, "packages", "web"), config)).toBe(true);
    expect(isProjectAllowedToSync(notes, config)).toBe(false);
  });
});
