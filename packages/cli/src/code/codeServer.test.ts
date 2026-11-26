// End-to-end over a STANDALONE loopback server: the /code handlers on a bare
// http.Server on port 0 with a fixed token, against a throwaway git repo in a
// temp dir. Never touches the daemon running on this machine or the person's
// own git config or vimrc.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import type {
  CodeBlameResponse,
  CodeGitBaseResponse,
  CodeGitStatusResponse,
  CodeSearchEvent,
  CodeVimrcResponse,
} from "@codecast/shared/contracts";
import { execFileSync, TOOL_PATH, whichBin } from "../proc.js";
import { pollUntil } from "../test-helpers/pollUntil.js";
import { addVault } from "../vault/vaultRegistry.js";
import { clearRepoScopeCache } from "../vault/vaultScope.js";
import { handleVaultHttp } from "../vault/vaultServer.js";
import { defaultBranch, invalidateGitStatus } from "./codeGit.js";
import type { SearchEngines } from "./codeSearch.js";
import { handleCodeHttp, type CodeServerOptions } from "./codeServer.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const ORIGIN = "http://localhost:3000";
const SAVED_ENV = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };

let base = "";
let configDir = "";
let home = "";
let repo = "";
let repoVault = "";
let subVault = "";
let plainVault = "";
let mixedVault = "";
let headSha = "";
let engines: SearchEngines | undefined;
let server: http.Server;
let port = 0;

function opts(): CodeServerOptions {
  return { token: TOKEN, log: () => {}, configDir, homeDir: home, searchEngines: engines };
}

function api(pathAndQuery: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
    ...init,
    headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
}

function sh(cwd: string, ...args: string[]): string {
  return String(execFileSync("git", args, { cwd, encoding: "utf8" })).trim();
}

function write(rel: string, content: string, root = repo): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function search(vault: string, query: string): Promise<CodeSearchEvent[]> {
  const res = await api(`/code/search?vault=${vault}&${query}`);
  expect(res.headers.get("content-type")).toContain("application/x-ndjson");
  return (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as CodeSearchEvent);
}

const filesOf = (events: CodeSearchEvent[]) =>
  events.flatMap((e) => (e.type === "file" ? [e.path] : [])).sort();
const doneOf = (events: CodeSearchEvent[]) => events.find((e) => e.type === "done") as Extract<CodeSearchEvent, { type: "done" }>;

beforeAll(async () => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-server-")));
  configDir = path.join(base, ".codecast");
  home = path.join(base, "home");
  repo = path.join(base, "repo");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });

  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "test@example.com");
  sh(repo, "config", "user.name", "Test Author");
  write("src/a.ts", "const needle = 1;\nconst other = 2;\nexport { needle };\n");
  write("src/b.ts", "// Needle in caps\nneedles plural\n");
  write("src/wide.ts", "const héllo = 'needle';\n");
  write("README.md", "# readme\nneedle in docs\n");
  write(".github/workflow.yml", "name: needle\n");
  write(".cache/blob.txt", "needle in a tool cache\n");
  write("dist/out.js", "needle in build output\n");
  write("node_modules/pkg/index.js", "needle in a dependency\n");
  write(".gitignore", "secret.txt\n");
  write("secret.txt", "needle in an ignored file\n");
  write("sub/notes.md", "sub needle\nline two\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "init");
  headSha = sh(repo, "rev-parse", "HEAD");

  // The working tree the status and blame tests read.
  write("src/a.ts", "const needle = 1;\nconst changed = 3;\nexport { needle };\n");
  fs.rmSync(path.join(repo, "src/b.ts"));
  write("src/new.ts", "brand new needle\n");
  sh(repo, "mv", "README.md", "docs.md");
  write("sub/notes.md", "sub needle\nline two edited\n");

  repoVault = addVault(configDir, repo, "Repo").id;
  subVault = addVault(configDir, path.join(repo, "sub"), "Sub").id;
  const plain = path.join(base, "plain");
  fs.mkdirSync(path.join(plain, ".hidden"), { recursive: true });
  fs.writeFileSync(path.join(plain, "note.md"), "plain needle\n");
  fs.writeFileSync(path.join(plain, ".hidden", "h.md"), "hidden needle\n");
  // A minified bundle: one 1.2 MB line, non-ASCII throughout, ~58k matches of "ab".
  fs.writeFileSync(path.join(plain, "min.js"), `${"é".repeat(3)}${"ab".repeat(10)}`.repeat(58 * 1024 / 10));
  plainVault = addVault(configDir, plain, "Plain").id;
  // A checked-in bundle with more matches than the cap, beside many small files.
  const mixed = path.join(base, "mixed");
  fs.mkdirSync(mixed, { recursive: true });
  fs.writeFileSync(path.join(mixed, "0.min.js"), "ab".repeat(6_000));
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(mixed, `f${i}.txt`), "one ab here\n");
  fs.writeFileSync(path.join(mixed, "a.ts"), "ab\n");
  fs.writeFileSync(path.join(mixed, "b.tsx"), "ab\n");
  fs.writeFileSync(path.join(mixed, "c.js"), "ab\n");
  // A repository with nothing committed, so the git-grep pass really runs git grep.
  sh(mixed, "init", "-q", "-b", "main");
  mixedVault = addVault(configDir, mixed, "Mixed").id;
  clearRepoScopeCache();

  server = http.createServer((req, res) => {
    if (handleCodeHttp(req, res, opts())) return;
    if (handleVaultHttp(req, res, opts())) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.closeAllConnections?.();
  server.close();
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(base, { recursive: true, force: true });
});

describe("envelope", () => {
  test("preflight, auth, unknown vault, bad requests", async () => {
    const pre = await fetch(`http://127.0.0.1:${port}/code/search`, { method: "OPTIONS", headers: { Origin: ORIGIN } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect((await fetch(`http://127.0.0.1:${port}/code/vimrc`, { headers: { Origin: ORIGIN } })).status).toBe(403);
    expect((await api(`/code/git/status?vault=nope`)).status).toBe(404);
    expect((await api(`/code/search?vault=${repoVault}`)).status).toBe(400);
    expect((await api(`/code/git/base?vault=${repoVault}&path=../etc/passwd`)).status).toBe(400);
    expect((await api(`/code/blame?vault=${repoVault}&path=.git/config`)).status).toBe(400);
    expect((await api(`/code/nope?vault=${repoVault}`)).status).toBe(404);
  });
});

// The rg engine runs only where ripgrep is installed; the fallbacks run everywhere.
const rgBin = whichBin("rg", TOOL_PATH);
for (const [engine, pinned] of [
  ["rg", undefined],
  ["git-grep", { rg: null }],
  ["walk", { rg: null, gitGrep: false }],
] as const) {
  describe.skipIf(engine === "rg" && !rgBin)(`search via ${engine}`, () => {
    beforeAll(() => {
      engines = pinned;
    });
    afterAll(() => {
      engines = undefined;
    });

    test("scope matches the file tree", async () => {
      const events = await search(repoVault, "q=needle");
      expect(doneOf(events).engine).toBe(engine);
      // Build output, tool dot-dirs, dependencies and gitignored files stay out;
      // the prose dot-dir .github stays in.
      expect(filesOf(events)).toEqual([".github/workflow.yml", "docs.md", "src/a.ts", "src/new.ts", "src/wide.ts", "sub/notes.md"]);
    });

    test("ignored=1 lifts the repo rules but never the always-ignored ones", async () => {
      const files = filesOf(await search(repoVault, "q=needle&ignored=1"));
      expect(files).toContain("dist/out.js");
      expect(files).toContain("secret.txt");
      expect(files).not.toContain("node_modules/pkg/index.js");
    });

    test("ranges are UTF-16 columns into the line", async () => {
      const events = await search(repoVault, "q=needle&include=src/wide.ts");
      const file = events.find((e) => e.type === "file") as Extract<CodeSearchEvent, { type: "file" }>;
      expect(file.lines).toEqual([{ line: 1, text: "const héllo = 'needle';", ranges: [{ start: 15, end: 21 }] }]);
    });

    test("literal and case-insensitive by default; case, word and regex flags", async () => {
      expect(filesOf(await search(repoVault, "q=NEEDLE&include=src"))).toEqual(["src/a.ts", "src/new.ts", "src/wide.ts"]);
      expect(filesOf(await search(repoVault, "q=NEEDLE&case=1"))).toEqual([]);
      expect(filesOf(await search(repoVault, "q=n..dle&include=src"))).toEqual([]);
      expect(filesOf(await search(repoVault, `q=${encodeURIComponent("const [a-z]+ = 3")}&regex=1`))).toEqual(["src/a.ts"]);
      const word = await search(plainVault, "q=need&word=1");
      expect(filesOf(word)).toEqual([]);
    });

    test("include and exclude globs", async () => {
      expect(filesOf(await search(repoVault, "q=needle&include=*.md"))).toEqual(["docs.md", "sub/notes.md"]);
      expect(filesOf(await search(repoVault, "q=needle&exclude=src,*.yml"))).toEqual(["docs.md", "sub/notes.md"]);
    });

    test("a subdirectory vault reports vault-relative paths", async () => {
      expect(filesOf(await search(subVault, "q=needle"))).toEqual(["notes.md"]);
    });

    test("a notes folder searches its dot-directories", async () => {
      expect(filesOf(await search(plainVault, "q=needle"))).toEqual([".hidden/h.md", "note.md"]);
    });

    test("max caps the total and marks it truncated", async () => {
      const events = await search(repoVault, "q=needle&max=2");
      const lines = events.flatMap((e) => (e.type === "file" ? e.lines : []));
      expect(lines.length).toBe(2);
      expect(doneOf(events)).toMatchObject({ matches: 2, truncated: true });
    });

    test("a long non-ASCII line with thousands of matches stays fast and exact", async () => {
      const started = Date.now();
      const events = await search(plainVault, "q=ab&include=min.js&max=1000");
      expect(Date.now() - started).toBeLessThan(5_000);
      const file = events.find((e) => e.type === "file") as Extract<CodeSearchEvent, { type: "file" }>;
      const [line] = file.lines;
      expect(line.ranges.length).toBeGreaterThan(10);
      for (const r of line.ranges) expect(line.text.slice(r.start, r.end)).toBe("ab");
      // Only the window's matches count toward the cap.
      expect(doneOf(events)).toMatchObject({ matches: line.ranges.length, truncated: false });
    });

    test("a minified file beside many small ones does not use up the cap", async () => {
      const events = await search(mixedVault, "q=ab");
      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(doneOf(events)).toMatchObject({ engine, truncated: false });
      expect(filesOf(events).length).toBe(304);
    });

    test("brace globs keep their alternates together", async () => {
      const brace = encodeURIComponent("*.{ts,tsx}");
      const included = await search(mixedVault, `q=ab&include=${brace}`);
      expect(included.some((e) => e.type === "error")).toBe(false);
      expect(doneOf(included).engine).toBe(engine);
      expect(filesOf(included)).toEqual(["a.ts", "b.tsx"]);
      const excluded = filesOf(await search(mixedVault, `q=ab&exclude=${encodeURIComponent("*.{txt,tsx}")}`));
      expect(excluded).toEqual(["0.min.js", "a.ts", "c.js"]);
    });

    test("a bad regex is an error event", async () => {
      const events = await search(repoVault, `q=${encodeURIComponent("(unclosed")}&regex=1`);
      expect(events.some((e) => e.type === "error")).toBe(true);
    });
  });
}

describe("search scope file", () => {
  test("lives in the config folder and comes back when something removes it", async () => {
    const file = path.join(configDir, "editor", "search.ignore");
    if (doneOf(await search(repoVault, "q=needle")).engine !== "rg") return; // only rg reads it
    expect(fs.readFileSync(file, "utf8")).toContain("dist");
    fs.rmSync(file);
    await search(repoVault, "q=needle");
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe("search streaming", () => {
  test("results stream before the engine exits, and a disconnect kills it", async () => {
    const pidFile = path.join(base, "fake-rg.pid");
    const fake = path.join(base, "fake-rg");
    const begin = JSON.stringify({ type: "begin", data: { path: { text: "./src/a.ts" } } });
    const match = JSON.stringify({
      type: "match",
      data: { path: { text: "./src/a.ts" }, lines: { text: "const needle = 1;\n" }, line_number: 1, submatches: [{ start: 6, end: 12 }] },
    });
    const end = JSON.stringify({ type: "end", data: { path: { text: "./src/a.ts" } } });
    fs.writeFileSync(fake, `#!/bin/sh\necho $$ > '${pidFile}'\nprintf '%s\\n' '${begin}' '${match}' '${end}'\nexec sleep 30\n`, { mode: 0o755 });
    engines = { rg: fake };
    try {
      const abort = new AbortController();
      const res = await api(`/code/search?vault=${repoVault}&q=needle`, { signal: abort.signal });
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const first = JSON.parse(new TextDecoder().decode(value).split("\n")[0]) as CodeSearchEvent;
      expect(first).toMatchObject({ type: "file", path: "src/a.ts" });
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      expect(alive()).toBe(true);
      abort.abort();
      await pollUntil(() => !alive(), "the search process to be killed");
    } finally {
      engines = undefined;
    }
  });
});

describe("git status", () => {
  test("folds porcelain v2 into vault-relative states", async () => {
    invalidateGitStatus();
    const body = (await (await api(`/code/git/status?vault=${repoVault}`)).json()) as CodeGitStatusResponse;
    expect(body).toMatchObject({ repo: true, branch: "main", head: headSha });
    expect(body.files).toEqual({
      "src/a.ts": "modified",
      "src/b.ts": "deleted",
      "src/new.ts": "untracked",
      "docs.md": "renamed",
      "sub/notes.md": "modified",
    });
  });

  test("a subdirectory vault sees only its own paths, relative to itself", async () => {
    const body = (await (await api(`/code/git/status?vault=${subVault}`)).json()) as CodeGitStatusResponse;
    expect(body.files).toEqual({ "notes.md": "modified" });
  });

  test("a folder outside any repo", async () => {
    const body = (await (await api(`/code/git/status?vault=${plainVault}`)).json()) as CodeGitStatusResponse;
    expect(body).toEqual({ repo: false, branch: null, head: null, files: {} });
  });

  test("a save through PUT /vault/file shows in the next status without fresh=1", async () => {
    await api(`/code/git/status?vault=${subVault}`);
    const file = path.join(repo, "sub/notes.md");
    const before = fs.readFileSync(file, "utf8");
    try {
      // Back to the committed text: the cached status still says modified.
      const res = await api(`/vault/file?vault=${subVault}&path=notes.md`, { method: "PUT", body: "sub needle\nline two\n" });
      expect(res.status).toBe(200);
      const body = (await (await api(`/code/git/status?vault=${subVault}`)).json()) as CodeGitStatusResponse;
      expect(body.files).toEqual({});
    } finally {
      fs.writeFileSync(file, before);
      invalidateGitStatus();
    }
  });

  test("fresh=1 sees a change inside the cache window", async () => {
    await api(`/code/git/status?vault=${subVault}`);
    write("sub/added.md", "x\n");
    try {
      const body = (await (await api(`/code/git/status?vault=${subVault}&fresh=1`)).json()) as CodeGitStatusResponse;
      expect(body.files["added.md"]).toBe("untracked");
    } finally {
      fs.rmSync(path.join(repo, "sub/added.md"));
      invalidateGitStatus();
    }
  });
});

describe("git base", () => {
  const base = async (vault: string, rel: string, ref?: string) =>
    api(`/code/git/base?vault=${vault}&path=${encodeURIComponent(rel)}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`);

  test("HEAD text of a modified file, with its blob sha", async () => {
    const body = (await (await base(repoVault, "src/a.ts")).json()) as CodeGitBaseResponse;
    expect(body).toMatchObject({ path: "src/a.ts", ref: "HEAD", exists: true, content: "const needle = 1;\nconst other = 2;\nexport { needle };\n" });
    expect(body.sha).toBe(sh(repo, "rev-parse", "HEAD:src/a.ts"));
  });

  test("a new file does not exist at HEAD; a renamed one reads its old name", async () => {
    expect(await (await base(repoVault, "src/new.ts")).json()).toEqual({ path: "src/new.ts", ref: "HEAD", exists: false });
    const renamed = (await (await base(repoVault, "docs.md")).json()) as CodeGitBaseResponse;
    expect(renamed.content).toBe("# readme\nneedle in docs\n");
  });

  test("a subdirectory vault resolves through its prefix", async () => {
    const body = (await (await base(subVault, "notes.md", headSha)).json()) as CodeGitBaseResponse;
    expect(body.content).toBe("sub needle\nline two\n");
  });

  test("refs: refused when unsafe, 404 when unknown", async () => {
    expect((await base(repoVault, "src/a.ts", "HEAD:secret")).status).toBe(400);
    expect((await base(repoVault, "src/a.ts", "--output=x")).status).toBe(400);
    expect((await base(repoVault, "src/a.ts", "no-such-branch")).status).toBe(404);
    expect((await base(plainVault, "note.md")).status).toBe(404);
  });
});

describe("git base at the merge base", () => {
  test("@merge-base reads the file where HEAD left main, then origin/HEAD once it exists", async () => {
    const fork = path.join(base, "fork");
    fs.mkdirSync(fork, { recursive: true });
    sh(fork, "init", "-q", "-b", "main");
    sh(fork, "config", "user.email", "test@example.com");
    sh(fork, "config", "user.name", "Test Author");
    write("f.ts", "one\n", fork);
    sh(fork, "add", "-A");
    sh(fork, "commit", "-q", "-m", "one");
    const forkPoint = sh(fork, "rev-parse", "HEAD");
    sh(fork, "checkout", "-q", "-b", "feature");
    write("f.ts", "feature\n", fork);
    sh(fork, "commit", "-qam", "feature");
    sh(fork, "checkout", "-q", "main");
    write("f.ts", "main moved on\n", fork);
    sh(fork, "commit", "-qam", "main two");
    sh(fork, "checkout", "-q", "feature");
    const forkVault = addVault(configDir, fork, "Fork").id;
    const read = (ref: string) => api(`/code/git/base?vault=${forkVault}&path=f.ts&ref=${encodeURIComponent(ref)}`);

    expect(await defaultBranch(fork)).toBe("main");
    const body = (await (await read("@merge-base")).json()) as CodeGitBaseResponse;
    expect(body).toMatchObject({ ref: "@merge-base", exists: true, content: "one\n" });
    expect(body.sha).toBe(sh(fork, "rev-parse", `${forkPoint}:f.ts`));

    // origin/HEAD names the default branch when there is one.
    sh(fork, "branch", "-q", "trunk", forkPoint);
    sh(fork, "update-ref", "refs/remotes/origin/trunk", "trunk");
    sh(fork, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    sh(fork, "checkout", "-q", "trunk");
    write("f.ts", "trunk\n", fork);
    sh(fork, "commit", "-qam", "trunk");
    sh(fork, "update-ref", "refs/remotes/origin/trunk", "trunk");
    sh(fork, "checkout", "-q", "feature");
    expect(await defaultBranch(fork)).toBe("origin/trunk");
    expect(((await (await read("@merge-base")).json()) as CodeGitBaseResponse).content).toBe("one\n");
    expect(((await (await read("origin/trunk")).json()) as CodeGitBaseResponse).content).toBe("trunk\n");
  });

  test("@merge-base with no default branch is an unknown ref", async () => {
    const lone = path.join(base, "lone");
    fs.mkdirSync(lone, { recursive: true });
    sh(lone, "init", "-q", "-b", "work");
    sh(lone, "config", "user.email", "test@example.com");
    sh(lone, "config", "user.name", "Test Author");
    write("x.ts", "x\n", lone);
    sh(lone, "add", "-A");
    sh(lone, "commit", "-q", "-m", "x");
    const loneVault = addVault(configDir, lone, "Lone").id;
    expect((await api(`/code/git/base?vault=${loneVault}&path=x.ts&ref=%40merge-base`)).status).toBe(404);
  });
});

describe("blame", () => {
  test("committed and uncommitted runs, plain git blame when signed out", async () => {
    const body = (await (await api(`/code/blame?vault=${repoVault}&path=src/a.ts`)).json()) as CodeBlameResponse;
    expect(body.path).toBe("src/a.ts");
    expect(body.hunks.map(({ start, end, sha, uncommitted, author }) => ({ start, end, sha, uncommitted, author }))).toEqual([
      { start: 1, end: 1, sha: headSha, uncommitted: undefined, author: "Test Author" },
      { start: 2, end: 2, sha: undefined, uncommitted: true, author: undefined },
      { start: 3, end: 3, sha: headSha, uncommitted: undefined, author: "Test Author" },
    ]);
    expect(body.hunks[0].summary).toBe("init");
    expect(body.hunks.every((h) => !h.session)).toBe(true);
  });

  test("a staged rename keeps the lines' history", async () => {
    const body = (await (await api(`/code/blame?vault=${repoVault}&path=docs.md`)).json()) as CodeBlameResponse;
    expect(body.hunks).toEqual([expect.objectContaining({ start: 1, end: 2, sha: headSha, summary: "init" })]);
  });

  test("an untracked file is one uncommitted run", async () => {
    const body = (await (await api(`/code/blame?vault=${repoVault}&path=src/new.ts`)).json()) as CodeBlameResponse;
    expect(body.hunks).toHaveLength(1);
    expect(body.hunks[0]).toMatchObject({ start: 1, end: 1, uncommitted: true });
  });

  test("a subdirectory vault and the missing cases", async () => {
    const body = (await (await api(`/code/blame?vault=${subVault}&path=notes.md`)).json()) as CodeBlameResponse;
    expect(body.hunks.map((h) => [h.start, h.end, !!h.uncommitted])).toEqual([[1, 1, false], [2, 2, true]]);
    expect((await api(`/code/blame?vault=${repoVault}&path=src/b.ts`)).status).toBe(404);
    expect((await api(`/code/blame?vault=${plainVault}&path=note.md`)).status).toBe(404);
  });
});

describe("vimrc", () => {
  beforeAll(() => {
    write(".vimrc", [
      '" synthetic fixture',
      "let mapleader = ','",
      "if filereadable(expand('~/.vim/local.vim')) | source ~/.vim/local.vim | endif",
      "source /etc/hosts",
      "source ~/../escape.vim",
      "source ~/.vim/linked.vim",
      "runtime keys.vim",
      "so ~/.vim/missing.vim",
      "source ~/.vim/chain1.vim",
    ].join("\n"), home);
    write(".vim/local.vim", "set number\nsource ~/.vimrc\n", home); // a cycle back to the entry
    write(".vim/keys.vim", "nnoremap <leader>w :w<CR>\n", home);
    for (let i = 1; i <= 5; i++) write(`.vim/chain${i}.vim`, `" ${i}\nsource ~/.vim/chain${i + 1}.vim\n`, home);
    write(".vim/chain6.vim", "\" never read\n", home);
    write(".config/nvim/init.vim", "source ~/.vimrc\nset relativenumber\n", home);
    fs.writeFileSync(path.join(base, "escape.vim"), "outside home\n");
    fs.symlinkSync(path.join(base, "escape.vim"), path.join(home, ".vim/linked.vim")); // in home, resolves outside it
  });

  test("entry points in order, each followed by what it sources", async () => {
    const body = (await (await api("/code/vimrc")).json()) as CodeVimrcResponse;
    const v = (rel: string) => path.join(home, rel);
    expect(body.sources.map((s) => [s.path, s.sourced_from ?? null])).toEqual([
      [v(".vimrc"), null],
      [v(".vim/local.vim"), v(".vimrc")],
      [v(".vim/keys.vim"), v(".vimrc")],
      [v(".vim/chain1.vim"), v(".vimrc")],
      [v(".vim/chain2.vim"), v(".vim/chain1.vim")],
      [v(".vim/chain3.vim"), v(".vim/chain2.vim")],
      [v(".vim/chain4.vim"), v(".vim/chain3.vim")],
      [v(".config/nvim/init.vim"), null],
    ]);
    expect(body.sources[2].content).toBe("nnoremap <leader>w :w<CR>\n");
    expect(body.unread).toEqual([
      { path: "/etc/hosts", sourced_from: v(".vimrc"), reason: "outside home" },
      { path: path.join(base, "escape.vim"), sourced_from: v(".vimrc"), reason: "outside home" },
      { path: v(".vim/linked.vim"), sourced_from: v(".vimrc"), reason: "outside home" },
      { path: v(".vim/missing.vim"), sourced_from: v(".vimrc"), reason: "not found" },
      { path: v(".vim/chain5.vim"), sourced_from: v(".vim/chain4.vim"), reason: "too deep" },
    ]);
    expect(body.overlay).toBeNull();
  });

  test("the overlay is written atomically and served back", async () => {
    const put = await api("/code/vimrc/overlay", { method: "PUT", body: "set nowrap\n", headers: { "Content-Type": "text/plain" } });
    expect(put.status).toBe(200);
    const overlayFile = path.join(configDir, "editor", "vimrc");
    expect(await put.json()).toEqual({ path: overlayFile, bytes: 11 });
    expect(fs.readFileSync(overlayFile, "utf8")).toBe("set nowrap\n");
    expect(fs.readdirSync(path.dirname(overlayFile)).filter((n) => n.startsWith("."))).toEqual([]); // no temp file left
    const body = (await (await api("/code/vimrc")).json()) as CodeVimrcResponse;
    expect(body.overlay).toEqual({ path: overlayFile, content: "set nowrap\n" });
  });
});
