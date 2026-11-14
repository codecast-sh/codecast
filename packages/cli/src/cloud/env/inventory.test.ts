import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { ParityLedger } from "./parity";
import { classifyFolder, envNames, readLaptopEnvironment, recordMirrorSkips, recentSessionFolders } from "./inventory";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-cloud-inv-")));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

function repo(dir: string, files: Record<string, string>): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const [rel, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** A Claude transcript for `cwd`, under the slug Claude would use. */
function claudeSession(home: string, cwd: string, ageDays = 0): void {
  const dir = path.join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ cwd, type: "user" }) + "\n");
  const t = Date.now() / 1000 - ageDays * 86400;
  fs.utimesSync(file, t, t);
}

describe("classifyFolder", () => {
  const home = path.join(tmp, "home-c");
  const main = repo(path.join(home, "src", "app"), { "a.txt": "a" });
  test("a main checkout, a linked worktree, an unborn repo, a plain folder, scratch and the home", () => {
    const wt = path.join(home, "src", "app-wt");
    git(main, "worktree", "add", "-q", "-b", "feature", wt);
    const unborn = path.join(home, "src", "fresh");
    fs.mkdirSync(unborn, { recursive: true });
    git(unborn, "init", "-q");
    const plain = path.join(home, "notes");
    fs.mkdirSync(plain, { recursive: true });
    expect(classifyFolder(path.join(main), home)).toEqual({ kind: "repo", root: main });
    expect(classifyFolder(wt, home)).toEqual({ kind: "worktree", root: wt, main });
    expect(classifyFolder(unborn, home)).toEqual({ kind: "folder", path: unborn });
    expect(classifyFolder(plain, home)).toEqual({ kind: "folder", path: plain });
    expect(classifyFolder("/tmp/x", home).kind).toBe("skip");
    expect(classifyFolder(home, home).kind).toBe("skip");
  });
});

describe("recentSessionFolders", () => {
  test("only sessions inside the window count, and a folder that is gone is counted, not listed", () => {
    const home = path.join(tmp, "home-s");
    const a = path.join(home, "src", "a");
    fs.mkdirSync(a, { recursive: true });
    claudeSession(home, a);
    claudeSession(home, path.join(home, "src", "old"), 30);
    fs.mkdirSync(path.join(home, "src", "old"), { recursive: true });
    claudeSession(home, path.join(home, "src", "deleted"));
    const r = recentSessionFolders(home, Date.now() - 14 * 86_400_000);
    expect([...r.folders.keys()]).toEqual([a]);
    expect(r.gone).toBe(1);
  });
});

describe("recordMirrorSkips", () => {
  test("groups by folder and reason, keeps every path, and counts what leaves nothing behind", () => {
    const home = path.join(tmp, "home-m");
    fs.mkdirSync(path.join(home, ".claude", "skills", "x"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "skills", "x", "real.bin"), "x");
    for (const f of ["a/1.jsonl", "b/2.jsonl"]) { fs.mkdirSync(path.dirname(path.join(home, ".claude", "projects", f)), { recursive: true }); fs.writeFileSync(path.join(home, ".claude", "projects", f), "{}"); }
    fs.mkdirSync(path.join(home, ".aws"), { recursive: true });
    fs.writeFileSync(path.join(home, ".aws", "credentials"), "[default]");
    const l = new ParityLedger();
    recordMirrorSkips(l, [
      { path: ".claude/projects/a/1.jsonl", reason: "denied" },
      { path: ".claude/projects/b/2.jsonl", reason: "denied" },
      { path: ".claude/skills/x/real.bin", reason: "referenced path absent or excluded" },
      { path: ".claude/skills/x/nothing.md", reason: "referenced path absent or excluded" },
      { path: "src/app/README.md", reason: "excluded" },
      { path: ".aws/credentials", reason: "denied" },
      { path: ".claude/projects/gone.jsonl", reason: "denied" },
    ], home, [path.join(home, "src", "app")], [path.join(home, ".aws", "credentials")]);
    const items = l.all();
    // Two reasons under one folder: each group names its reason, so neither stands in for the other.
    expect(items.find((i) => i.name === "~/.claude: machine data")).toMatchObject({ status: "skipped", paths: ["~/.claude/projects/a/1.jsonl", "~/.claude/projects/b/2.jsonl"] });
    expect(items.find((i) => i.name === "~/.claude: excluded")).toMatchObject({ status: "skipped", paths: ["~/.claude/skills/x/real.bin"] });
    expect(items).toHaveLength(2);
    expect(l.scope.join("\n")).toContain("2 paths named in agent instruction files do not exist");
    expect(l.scope.join("\n")).toContain("1 paths the config mirror leaves out are logins");
    expect(l.scope.join("\n")).toContain("1 paths named in agent instruction files sit inside repositories");
  });
});

test("envNames keeps names only", () => {
  expect(envNames("A=1\0B_2=x=y\0bad line\0\nC=3\0")).toEqual(["A", "B_2", "C"]);
});

describe("readLaptopEnvironment", () => {
  setDefaultTimeout(60_000);
  test("every finding is planned or skipped with a reason, and the snapshot rules decide repo files", async () => {
    const home = path.join(tmp, "home-full");
    const app = repo(path.join(home, "src", "app"), { "package.json": "{}", "src/index.ts": "x", ".gitignore": "node_modules\n.env\nlocal.db\n" });
    fs.writeFileSync(path.join(app, "src", "index.ts"), "changed");
    fs.writeFileSync(path.join(app, ".env"), "SECRET=1");
    fs.mkdirSync(path.join(app, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(app, "node_modules", "dep", "i.js"), "x");
    fs.writeFileSync(path.join(app, "demo.mp4"), "video");
    fs.mkdirSync(path.join(app, "py", "env"), { recursive: true });
    fs.writeFileSync(path.join(app, "py", "env", "pyvenv.cfg"), "home = /usr");
    git(app, "stash", "list");
    const wt = path.join(home, "src", "app-wt");
    git(app, "worktree", "add", "-q", "-b", "wip", wt);
    fs.writeFileSync(path.join(wt, "new.ts"), "wip");
    const cleanWt = path.join(home, "src", "app-clean");
    git(app, "worktree", "add", "-q", "-b", "done", cleanWt);
    claudeSession(home, app);
    claudeSession(home, wt);
    claudeSession(home, cleanWt);
    const scratch = path.join(tmp, "scratchpad");
    fs.mkdirSync(scratch, { recursive: true });
    claudeSession(home, scratch);
    fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
    fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "k");

    const ledger = new ParityLedger();
    const plan = await readLaptopEnvironment(ledger, {
      home, now: Date.now(), days: 14, config: null, dryRun: false,
      footprint: () => ({ root: "", areas: [], services: [{ label: "com.me.worker", plist: path.join(home, "Library/LaunchAgents/com.me.worker.plist"), running: true }], tools: [{ tool: "ffmpeg", path: "/opt/homebrew/bin/ffmpeg", count: 4, install: { brew: "ffmpeg" } }, { tool: "mytool", path: path.join(home, "bin/mytool"), count: 5 }] }),
      mirror: async () => ({ entries: [{ path: ".claude/CLAUDE.md", kind: "verbatim", mode: "0600", bytes: Buffer.from("x"), root: ".claude" }], skipped: [{ path: ".claude/projects/x.jsonl", reason: "denied" }], excludesApplied: [], warnings: [], gitIdentity: {} }),
      required: () => ({ node: { minMajor: 22, install: "22.12.0", source: "laptop" }, clients: { claude: "2.1.0" }, tools: [{ tool: "gh", version: "2.86.0" }], unsupported: [{ tool: "helper", referenced_by: "~/.claude/hooks/x", reason: "a Mach-O binary" }], mcp: [], cli: {} }),
      loginShellEnv: () => ["OPENAI_API_KEY", "HOMEBREW_PREFIX", "PATH", "TERM"],
      listening: () => [{ command: "postgres", port: "5432", pid: "1" }, { command: "postgres", port: "5433", pid: "1" }, { command: "Slack", port: "1", pid: "2" },
        { command: "CommCenter", port: "5060", pid: "3" }, { command: "tmphelper", port: "51432", pid: "4" }],
      exePath: (pid) => ({ "1": "/opt/homebrew/bin/postgres", "2": "/Applications/Slack.app/Contents/MacOS/Slack", "3": "/System/Library/PrivateFrameworks/CommCenter", "4": "/Users/me/bin/tmphelper" })[pid] ?? "",
      containers: () => ["redis (redis:7)"],
    });
    const items = ledger.all();
    for (const i of items) {
      expect(["planned", "skipped"]).toContain(i.status);
      if (i.status === "skipped") expect(i.reason?.length).toBeGreaterThan(5);
    }
    const byName = (n: string) => items.find((i) => i.name === n);
    expect(plan.repos.map((r) => r.name)).toEqual(["~/src/app", "~/src/app-wt"]);
    expect(plan.repos[1]!.worktreeOf).toBe(app);
    expect(byName("~/src/app: branches")?.paths).toEqual(["~/src/app-clean"]);
    // .env (gitignored) travels; node_modules and the venv are rebuilt; the video stays.
    const snap = plan.repos[0]!.snapshot;
    expect(execFileSync("git", ["-C", app, "ls-tree", "-r", "--name-only", snap.sha!], { encoding: "utf-8" })).toContain(".env");
    expect(byName("~/src/app: rebuilt on each machine")?.paths).toEqual(expect.arrayContaining(["node_modules/", "py/env/"]));
    expect(byName("~/src/app: audio or video, fetched when needed")?.paths).toEqual(["demo.mp4"]);
    expect(byName(path.join(tmp, "scratchpad"))?.reason).toContain("outside your home folder");
    expect(byName("mytool")?.reason).toContain("not installed by Homebrew");
    expect(plan.extraTools.map((t) => t.tool)).toEqual(["ffmpeg"]);
    expect(byName("helper")?.status).toBe("skipped");
    expect(byName("OPENAI_API_KEY")?.status).toBe("planned");
    expect(byName("HOMEBREW_PREFIX")?.status).toBe("skipped");
    expect(byName("PATH")).toBeUndefined();
    expect(byName("postgres")).toMatchObject({ status: "skipped", detail: "ports 5432, 5433" });
    expect(byName("Slack")).toBeUndefined();
    expect(byName("CommCenter")).toBeUndefined();
    expect(byName("tmphelper")).toBeUndefined();
    expect(ledger.scope.join("\n")).toContain("3 listening sockets left out");
    expect(byName("container redis (redis:7)")?.status).toBe("skipped");
    expect(byName("com.me.worker")?.status).toBe("skipped");
    expect(byName("~/.ssh/id_ed25519")?.status).toBe("skipped");
    expect(byName("~/.claude")?.status).toBe("planned");
    expect(byName("agent and tool logins")?.reason).toContain("not signed in");
  });
});
