// End to end: a shared checkout with several sessions' uncommitted work, an
// upstream that moved, a credential file, a session still mid-turn and a
// writer typing into the tree while the ship runs. Real git, a bare origin,
// fake transcripts in an isolated CODECAST_DIR and HOME.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makePlan, runPlan, type ShipPlan } from "./shipCheckout.js";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
const saved: Record<string, string | undefined> = {};
let sandbox = "";

beforeAll(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-ship-e2e-")));
  for (const [k, v] of Object.entries({ ...ENV, HOME: sandbox, CODECAST_DIR: path.join(sandbox, ".codecast") })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, ...ENV } }).replace(/\n$/, "");
const write = (dir: string, file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf-8");

let n = 0;
function world(files: Record<string, string>, ship: string) {
  const root = path.join(sandbox, `w${++n}`);
  fs.mkdirSync(root);
  const seed = path.join(root, "seed");
  fs.mkdirSync(seed);
  sh(seed, "init", "-q", "-b", "main");
  for (const [f, t] of Object.entries({ ...files, ".codecast/workspace.toml": ship, ".gitignore": "node_modules/\n" })) write(seed, f, t);
  sh(seed, "add", "-A");
  sh(seed, "commit", "-qm", "base");
  execFileSync("git", ["clone", "-q", "--bare", seed, path.join(root, "origin.git")]);
  execFileSync("git", ["clone", "-q", path.join(root, "origin.git"), path.join(root, "shared")]);
  execFileSync("git", ["clone", "-q", path.join(root, "origin.git"), path.join(root, "other")]);
  const shared = path.join(root, "shared");
  const other = path.join(root, "other");
  sh(shared, "remote", "set-head", "origin", "main");
  // Each world its own state dir: the sync ledger store is cached per path.
  process.env.CODECAST_DIR = path.join(root, ".codecast");
  return {
    shared,
    other,
    upstream(changes: Record<string, string>, msg = "upstream work") {
      for (const [f, t] of Object.entries(changes)) write(other, f, t);
      sh(other, "add", "-A");
      sh(other, "commit", "-qm", msg);
      sh(other, "push", "-q", "origin", "main");
    },
    originLog: () => sh(path.join(root, "origin.git"), "log", "--format=%s", "main"),
    originFile: (f: string) => sh(path.join(root, "origin.git"), "show", `main:${f}`),
  };
}

/** A Claude transcript in the sandbox, registered in the sync ledger as `conversationId`. */
function transcript(sessionId: string, conversationId: string, lines: object[], status?: string) {
  const dir = path.join(sandbox, ".claude", "projects", "-sandbox");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const ledgerFile = path.join(process.env.CODECAST_DIR!, "sync-ledger.json");
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, "utf-8")) : {};
  ledger[file] = { lastSyncedAt: Date.now(), lastSyncedPosition: 0, messageCount: lines.length, conversationId, sourceGeneration: { client: "claude", sessionId, dev: 0, ino: 0, birthtimeMs: 0, unit: "bytes", watermark: 0, prefixProven: true } };
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
  if (status) {
    const statusDir = path.join(process.env.CODECAST_DIR!, "agent-status");
    fs.mkdirSync(statusDir, { recursive: true });
    fs.writeFileSync(path.join(statusDir, `${sessionId}.json`), JSON.stringify({ status, ts: Math.floor(Date.now() / 1000) }));
  }
}

const at = (ms: number) => new Date(Date.now() - ms).toISOString();
const edit = (cwd: string, file: string, ms: number) => ({ type: "assistant", timestamp: at(ms), cwd, message: { role: "assistant", content: [{ type: "tool_use", id: `t${Math.random()}`, name: "Edit", input: { file_path: path.join(cwd, file), old_string: "a", new_string: "b" } }] } });
const bash = (cwd: string, command: string, ms: number) => ({ type: "assistant", timestamp: at(ms), cwd, message: { role: "assistant", content: [{ type: "tool_use", id: `t${Math.random()}`, name: "Bash", input: { command } }] } });
const said = (text: string, ms: number) => ({ type: "assistant", timestamp: at(ms), message: { role: "assistant", content: [{ type: "text", text }] } });

const DIRECT = `[ship]\nmode = "direct"\ncheck = "test ! -e BROKEN"\ntests = false\n\n[[ship.deploy]]\nname = "backend"\nwhen = ["server/**"]\nrun = "git rev-parse HEAD > ../deployed-at && test -z \\"$(git log origin/main..HEAD --format=%s | grep -v . )\\""\nstage = "before_push"\n`;

describe("cast ship checkout, direct mode", () => {
  test("ships two sessions' work as two commits onto a moved upstream, holds credentials, keeps a live writer's edits", async () => {
    const w = world({ "server/api.ts": "export const api = 1;\n", "web/page.tsx": "export const page = 1;\n", "shared/util.ts": "export const u = 1;\n", "README.md": "# r\n" }, DIRECT);
    const { shared } = w;
    w.upstream({ "README.md": "# r\n\nupstream line\n" });

    // Session A (Edit tool) changed the server; session B (a python heredoc) the web page and a new file.
    write(shared, "server/api.ts", "export const api = 2;\n");
    write(shared, "web/page.tsx", "export const page = 2;\nimport { helper } from \"./helper\";\n");
    write(shared, "web/helper.ts", "export const helper = 1;\n");
    write(shared, ".env.local", "SECRET=sk-ant-REDACTEDREDACTEDREDACTEDREDACTED\n");
    write(shared, "notes.txt", "a person typed this\n");
    transcript("sess-a", "jx7aaaaaaaaaaaaaaaaaaaaaaaaaaaaa", [edit(shared, "server/api.ts", 60_000), said("Server change done and tested.", 50_000)]);
    transcript("sess-b", "jx7bbbbbbbbbbbbbbbbbbbbbbbbbbbbb", [
      bash(shared, `cd ${shared} && python3 - <<'EOF'\np='web/page.tsx'\nopen(p,'w').write(x)\nEOF`, 40_000),
      bash(shared, `cat > web/helper.ts <<'EOF'\nexport const helper = 1;\nEOF`, 30_000),
      said("Page wired to the helper.", 20_000),
    ]);

    const plan = await makePlan(shared, { roster: async () => [{ short_id: "jx7aaaa", title: "Speed up the api", work_state: "idle" }, { short_id: "jx7bbbb", title: "Fix the page helper", work_state: "idle" }] });
    const byId = Object.fromEntries(plan.groups.map((g) => [g.id, g]));
    expect(byId["s:jx7aaaa"].paths).toEqual(["server/api.ts"]);
    expect(byId["s:jx7aaaa"].message).toBe("feat(server): speed up the api");
    expect(byId["s:jx7bbbb"].paths).toEqual(["web/helper.ts", "web/page.tsx"]);
    expect(byId["s:jx7bbbb"].message).toBe("fix(web): fix the page helper");
    expect(byId["unattributed"].paths).toEqual(["notes.txt"]);
    expect(byId["credentials"].ship).toBe(false);
    expect(byId["credentials"].paths).toEqual([".env.local"]);
    expect(plan.behind).toBe(1);

    // A session keeps typing into a shipped file and a new file while the ship runs.
    let ticks = 0;
    const typing = setInterval(() => { ticks++; write(shared, "server/api.ts", `export const api = 2;\n// typing ${ticks}\n`); write(shared, "scratch.ts", `// ${ticks}\n`); }, 5);
    await new Promise((r) => setTimeout(r, 30));
    const result = await runPlan(plan).finally(() => clearInterval(typing));
    expect(result.reason).toBeUndefined();
    expect(result.ok).toBe(true);

    // The report names the commits as they landed, not as first built.
    expect(result.commits.map((c) => c.sha).every((sha) => w.originLog() && sh(path.join(shared, "..", "origin.git"), "merge-base", "--is-ancestor", sha, "main") === "")).toBe(true);
    const shipped = plan.groups.filter((g) => g.ship).map((g) => g.message).reverse();
    expect(w.originLog().split("\n")).toEqual([...shipped, "upstream work", "base"]);
    expect(w.originFile("server/api.ts")).toBe("export const api = 2;");
    expect(() => w.originFile(".env.local")).toThrow();
    expect(sh(shared, "rev-parse", "HEAD")).toBe(sh(shared, "rev-parse", "origin/main"));
    expect(read(shared, "README.md")).toContain("upstream line");
    // The writer's edits survive: the shipped file carries its later typing, uncommitted.
    expect(read(shared, "server/api.ts")).toContain(`// typing ${ticks}`);
    const status = sh(shared, "status", "--porcelain").split("\n").sort();
    expect(status).toEqual([" M server/api.ts", "?? .env.local", "?? scratch.ts"]);
    // The before-push deploy ran against the levelled tree.
    expect(result.deploys).toEqual([{ name: "backend", stage: "before_push", ok: true }]);
    expect(fs.readFileSync(path.join(shared, "..", "deployed-at"), "utf-8").trim()).toBe(result.pushed!);
  });

  test("a held session is left uncommitted; a shipped file importing it stops the ship before anything leaves", async () => {
    const w = world({ "app/main.ts": "export const m = 1;\n" }, DIRECT);
    const { shared } = w;
    write(shared, "app/main.ts", "import { half } from \"./half\";\nexport const m = half;\n");
    write(shared, "app/half.ts", "export const half = 1;\n");
    transcript("sess-c", "jx7ccccccccccccccccccccccccccccc", [edit(shared, "app/main.ts", 50_000)]);
    transcript("sess-d", "jx7ddddddddddddddddddddddddddddd", [edit(shared, "app/half.ts", 40_000), said("Still wiring this up, next I'll", 1000)], "working");
    const plan = await makePlan(shared, {});
    const half = plan.groups.find((g) => g.id === "s:jx7dddd")!;
    expect(half.session?.mid_turn).toBe(true);
    expect(half.session?.last_text).toContain("Still wiring");
    half.ship = false;
    const before = w.originLog();
    const r = await runPlan(plan);
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("check");
    expect(r.import_gaps).toEqual(["app/main.ts imports ./half, which is held back or not committed"]);
    expect(w.originLog()).toBe(before);
    expect(sh(shared, "status", "--porcelain").split("\n").sort()).toEqual([" M app/main.ts", "?? app/half.ts"]);
  });

  test("a failing check in a shipped file stops before the push; one only in a held file is ignored", async () => {
    const check = `[ship]\nmode = "direct"\ncheck = "grep -n BROKEN -r --include=*.ts . | sed 's/:/(/; s/:/,1): error /' ; ! grep -rq BROKEN --include=*.ts ."\ntests = false\n`;
    const w = world({ "a.ts": "export const a = 1;\n", "b.ts": "export const b = 1;\n" }, check);
    const { shared } = w;
    write(shared, "a.ts", "export const a = 2;\n");
    write(shared, "b.ts", "export const b = 2; // BROKEN\n");
    transcript("sess-e", "jx7eeeeeeeeeeeeeeeeeeeeeeeeeeeee", [edit(shared, "a.ts", 50_000)]);
    transcript("sess-f", "jx7fffffffffffffffffffffffffffff", [edit(shared, "b.ts", 40_000)]);
    const plan = await makePlan(shared, {});
    plan.groups.find((g) => g.id === "s:jx7ffff")!.ship = false;
    const r = await runPlan(plan);
    expect(r.reason).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.check?.ignored?.[0]).toContain("b.ts");
    expect(w.originFile("a.ts")).toBe("export const a = 2;");

    // Now the broken file ships: the check names it and nothing is pushed.
    const plan2 = await makePlan(shared, {});
    const before = w.originLog();
    const r2 = await runPlan(plan2);
    expect(r2.ok).toBe(false);
    expect(r2.stage).toBe("check");
    expect(w.originLog()).toBe(before);
  });

  test("the checkout's own commits ship first, replayed onto upstream", async () => {
    const w = world({ "x.ts": "1\n", "y.ts": "1\n" }, DIRECT);
    const { shared } = w;
    write(shared, "x.ts", "2\n");
    sh(shared, "commit", "-qam", "fix(x): an agent committed here");
    w.upstream({ "z.ts": "z\n" });
    write(shared, "y.ts", "2\n");
    const plan = await makePlan(shared, {});
    expect(plan.local_commits.map((c) => c.subject)).toEqual(["fix(x): an agent committed here"]);
    const r = await runPlan(plan);
    expect(r.ok).toBe(true);
    expect(w.originLog().split("\n").slice(0, 3)).toEqual([plan.groups[0].message, "fix(x): an agent committed here", "upstream work"]);
    expect(sh(shared, "status", "--porcelain")).toBe("");
    expect(read(shared, "z.ts")).toBe("z\n");
  });
});

describe("cast ship checkout, pr mode", () => {
  test("pushes a branch, opens the pull request, and leaves the checkout's files and branch alone", async () => {
    const w = world({ "a.ts": "1\n" }, `[ship]\nmode = "pr"\ncheck = "true"\ntests = false\n`);
    const { shared } = w;
    write(shared, "a.ts", "2\n");
    transcript("sess-p", "jx7ppppppppppppppppppppppppppppp", [edit(shared, "a.ts", 10_000)]);
    const bin = path.join(sandbox, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\necho "$@" > ${sandbox}/gh-args\necho https://github.com/o/r/pull/7\n`, { mode: 0o755 });
    const PATH = process.env.PATH;
    process.env.PATH = `${bin}:${PATH}`;
    try {
      const head = sh(shared, "rev-parse", "HEAD");
      const r = await runPlan(await makePlan(shared, {}));
      expect(r.ok).toBe(true);
      expect(r.pr).toBe("https://github.com/o/r/pull/7");
      const branch = fs.readFileSync(path.join(sandbox, "gh-args"), "utf-8").match(/--head (\S+)/)![1];
      expect(sh(path.join(shared, "..", "origin.git"), "show", `${branch}:a.ts`)).toBe("2");
      expect(sh(shared, "rev-parse", "HEAD")).toBe(head);
      expect(read(shared, "a.ts")).toBe("2\n");
    } finally {
      process.env.PATH = PATH;
    }
  });
});

describe("cast ship checkout, upstream moves mid-ship", () => {
  test("a push rejected because upstream moved replays onto it, levels again, and lands", async () => {
    const race = `[ship]\nmode = "direct"\ncheck = "true"\ntests = false\n\n[[ship.deploy]]\nname = "race"\nrun = "cd ../other && echo raced > raced.ts && git add raced.ts && git -c user.name=t -c user.email=t@t commit -qm 'raced in' && git push -q origin main"\nstage = "before_push"\n`;
    const w = world({ "a.ts": "1\n" }, race);
    const { shared } = w;
    write(shared, "a.ts", "2\n");
    transcript("sess-r", "jx7rrrrrrrrrrrrrrrrrrrrrrrrrrrrr", [edit(shared, "a.ts", 10_000)]);
    const plan = await makePlan(shared, {});
    const r = await runPlan(plan);
    expect(r.reason).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(w.originLog().split("\n").slice(0, 2)).toEqual([plan.groups[0].message, "raced in"]);
    expect(sh(shared, "rev-parse", "HEAD")).toBe(sh(path.join(shared, "..", "origin.git"), "rev-parse", "main"));
    expect(read(shared, "raced.ts")).toBe("raced\n");
    expect(r.commits[0].sha).toBe(sh(path.join(shared, "..", "origin.git"), "rev-parse", "main"));
  });
});
