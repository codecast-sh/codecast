import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { caseSetLines, heldTreeProblem, putCaseSet, putCaseSetMeta, withCaseFile } from "./envCases.js";
import { execFileSync } from "node:child_process";
import { LOCAL_CASES_ENV, runEnv, runWithCases } from "./envCommand.js";
import { heldCaseId, type EnvDeclaration } from "@codecast/shared/contracts/envs";
import { CASES_FILE_ENV } from "@codecast/shared/contracts/envCases";

// The CLI half of held sets (envHeld.ts). Pinned: the fetch writes a private
// file only the runner sees and removes it whatever happens; a dev run never
// sees the variable; held ids leave hashed; an upload prints no case; and no
// CLI or web source reaches the fetch routes except this one reader.

const SECRET = "SECRET-PITCH-TEXT";
const plain = { green: "", yellow: "", red: "", cyan: "", dim: "", bold: "", reset: "" };

function fakeServer() {
  const calls: { url: string; body: any }[] = [];
  const stored = [{ id: "case-0", payload: JSON.stringify({ pitch: `${SECRET} 0` }) }, { id: "case-1", payload: JSON.stringify({ pitch: `${SECRET} 1` }) }];
  const post = async (url: string, body: Record<string, unknown>) => {
    calls.push({ url, body: structuredClone(body) });
    if (url === "/cli/envs/cases/open") return { read: "r1", version: "0123456789abcdef", size: 2, meta: JSON.stringify({ seed: "s" }) };
    if (url === "/cli/envs/cases/page") return body.from === 0 ? { cases: [stored[0]], next: 1 } : { cases: [stored[1]], next: null };
    if (url === "/cli/envs/cases/put") return { set: "set1", written: (body.cases as any[]).length, live: true, workspace: "team:t" };
    throw new Error(`unexpected ${url}`);
  };
  return { post, calls };
}

describe("withCaseFile", () => {
  test("writes every page to a private file for the run and removes it after", async () => {
    const { post, calls } = fakeServer();
    let seen = "";
    const out = await withCaseFile(post, "acme/x", "held", { session_id: "jx1", task_id: "ct-2" }, async (file, { version, read }) => {
      seen = file;
      expect(read).toBe("r1");
      expect((fs.statSync(file).mode & 0o777).toString(8)).toBe("600");
      expect((fs.statSync(path.dirname(file)).mode & 0o777).toString(8)).toBe("700");
      const body = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(body).toMatchObject({ env: "acme/x", split: "held", version, meta: { seed: "s" } });
      expect(body.cases.map((c: any) => c.id)).toEqual(["case-0", "case-1"]);
      return 7;
    });
    expect(out).toBe(7);
    expect(fs.existsSync(path.dirname(seen))).toBe(false);
    expect(calls[0]).toMatchObject({ url: "/cli/envs/cases/open", body: { env: "acme/x", split: "held", session_id: "jx1", task_id: "ct-2" } });
  });

  test("removes the file when the run throws", async () => {
    const { post } = fakeServer();
    let seen = "";
    await expect(withCaseFile(post, "acme/x", "held", {}, async (file) => { seen = file; throw new Error("boom"); })).rejects.toThrow("boom");
    expect(fs.existsSync(path.dirname(seen))).toBe(false);
  });
});

describe("runEnv with a held file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "held-runner-"));
  const runner = path.join(dir, "runner.js");
  // Reads the held file when it is given, prints raw ids; reports whether it saw the variable.
  fs.writeFileSync(runner, `
const f = process.env.${CASES_FILE_ENV};
const split = process.argv[2];
const ids = f ? JSON.parse(require("fs").readFileSync(f, "utf8")).cases.map(c => c.id) : ["dev-a"];
console.log(JSON.stringify({ env: "acme/x", env_version: split === "held" ? "abcd1234" : (f ? "saw-held" : "v1"), level: "L2", candidate: { label: "base" }, split,
  cases: ids.map(id => ({ id, score: 0.5 })), summary: { n: ids.length, mean: 0.5 }, started_at: "2026-11-17T10:00:00Z", finished_at: "2026-11-17T10:00:01Z" }));
`);
  const decl: EnvDeclaration = { key: "acme/x", title: "x", level: "L2", command: `node ${runner} {split}`, splits: ["dev", "held"] };

  test("a held run reads the file and files only hashed ids", async () => {
    const file = path.join(dir, "held.json");
    fs.writeFileSync(file, JSON.stringify({ env: "acme/x", version: "v", cases: [{ id: "case-0", payload: SECRET }] }));
    const r = await runEnv(decl, { dir, candidate: "base", split: "held", casesFile: file, quiet: true });
    if (!r.ok) throw new Error(r.error);
    expect(r.result.cases).toEqual([{ id: await heldCaseId("acme/x", "case-0"), score: 0.5 }]);
    expect(JSON.stringify(r.result)).not.toContain(SECRET);
  });

  test("a held runner's stderr is withheld; a runner's own h: ids are kept", async () => {
    const noisy: EnvDeclaration = { ...decl, command: `node -e 'console.error("${SECRET}"); console.log(JSON.stringify({ env: "acme/x", env_version: "abcd1234", level: "L2", candidate: { label: "base" }, split: "held", cases: [{ id: "h:0123456789abcdef", score: 1 }], summary: { n: 1, mean: 1 }, started_at: "2026-11-17T10:00:00Z", finished_at: "2026-11-17T10:00:01Z" }))'` };
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
    try {
      const r = await runEnv(noisy, { dir, candidate: "base", split: "held", casesFile: path.join(dir, "held.json") });
      if (!r.ok) throw new Error(r.error);
      expect(r.result.cases[0].id).toBe("h:0123456789abcdef");
    } finally {
      console.error = orig;
    }
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(lines.join("\n")).toContain("1 line of runner output withheld");
  });

  test("a runner's leftover children end with it", async () => {
    const marker = path.join(dir, "late.txt");
    fs.rmSync(marker, { force: true });
    const lingering: EnvDeclaration = { ...decl, command: `(sleep 2; echo late > ${marker}) & echo '{"env":"acme/x","env_version":"v1","level":"L2","candidate":{"label":"base"},"split":"dev","cases":[{"id":"a","score":1}],"summary":{"n":1,"mean":1},"started_at":"2026-11-17T10:00:00Z","finished_at":"2026-11-17T10:00:01Z"}'` };
    const r = await runEnv(lingering, { dir, candidate: "base", split: "dev", quiet: true });
    expect(r.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 3000));
    expect(fs.existsSync(marker)).toBe(false);
  }, 15_000);

  test("a runner sees only the file it was given: a stray variable in the environment is dropped", async () => {
    process.env[CASES_FILE_ENV] = path.join(dir, "held.json");
    try {
      const r = await runEnv(decl, { dir, candidate: "base", split: "dev", quiet: true });
      if (!r.ok) throw new Error(r.error);
      expect(r.result.env_version).toBe("v1");
    } finally {
      delete process.env[CASES_FILE_ENV];
    }
  });
});

describe("an interrupted run", () => {
  test("Ctrl-C during a held run stops the runner and removes the file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "held-sigint-"));
    const marker = path.join(dir, "still-running.txt");
    const seen = path.join(dir, "file.txt");
    const script = path.join(dir, "driver.ts");
    const src = path.resolve(import.meta.dir);
    fs.writeFileSync(script, `
import { withCaseFile } from ${JSON.stringify(path.join(src, "envCases.ts"))};
import { runEnv } from ${JSON.stringify(path.join(src, "envCommand.ts"))};
const post = async (url: string) => url.endsWith("/open") ? { read: "r", version: "0123456789abcdef", size: 1 } : { cases: [{ id: "a", payload: "1" }], next: null };
const decl = { key: "acme/x", title: "x", level: "L2", command: "echo $CODECAST_ENV_CASES > ${seen}; sleep 3; echo late > ${marker}", splits: ["held"] } as any;
await withCaseFile(post as any, "acme/x", "held", {}, (file) => runEnv(decl, { dir: ${JSON.stringify(dir)}, candidate: "base", split: "held", casesFile: file, quiet: true }));
`);
    const child = Bun.spawn([process.execPath, script], { cwd: dir, stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 100 && !fs.existsSync(seen); i++) await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(seen)).toBe(true);
    const casesFile = fs.readFileSync(seen, "utf8").trim();
    expect(fs.existsSync(casesFile)).toBe(true);
    child.kill("SIGINT");
    await child.exited;
    expect(fs.existsSync(casesFile)).toBe(false);
    await new Promise((r) => setTimeout(r, 4000));
    expect(fs.existsSync(marker)).toBe(false);
  }, 20_000);
});

describe("heldTreeProblem", () => {
  const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  function repo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "held-tree-"));
    git(dir, "init", "-q");
    fs.mkdirSync(path.join(dir, ".codecast"));
    fs.mkdirSync(path.join(dir, "eval"));
    fs.writeFileSync(path.join(dir, ".codecast/envs.toml"), "# envs\n");
    fs.writeFileSync(path.join(dir, "eval/runner.ts"), "run()\n");
    fs.writeFileSync(path.join(dir, "prompt.md"), "v1\n");
    git(dir, "add", ".");
    git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
    return { dir, base: execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim() };
  }
  const decl: EnvDeclaration = { key: "acme/x", title: "x", level: "L2", command: "true", splits: ["held"], protects: ["eval/**"] };

  test("a held run needs protected paths, and the base's runner", () => {
    const { dir, base } = repo();
    expect(heldTreeProblem(dir, { ...decl, protects: undefined }, base)).toMatch(/protects no paths/);
    expect(heldTreeProblem(dir, decl, null)).toMatch(/no base/);
    expect(heldTreeProblem(dir, decl, base)).toBeNull();
    const commit = () => { git(dir, "add", "-A"); git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "c"); };
    // Uncommitted anything (product code the runner imports included) is refused.
    fs.writeFileSync(path.join(dir, "prompt.md"), "v2\n");
    expect(heldTreeProblem(dir, decl, base)).toMatch(/committed tree: prompt.md is uncommitted/);
    fs.writeFileSync(path.join(dir, "product.mjs"), "copy()\n");
    expect(heldTreeProblem(dir, decl, base)).toMatch(/product.mjs/);
    // A committed candidate that leaves protected paths alone runs.
    commit();
    expect(heldTreeProblem(dir, decl, base)).toBeNull();
    // A committed change to the runner, a new protected file, or the declaration does not.
    fs.writeFileSync(path.join(dir, "eval/runner.ts"), "dump()\n");
    commit();
    expect(heldTreeProblem(dir, decl, base)).toMatch(/eval\/runner.ts differ/);
    git(dir, "checkout", base, "--", "eval/runner.ts");
    fs.writeFileSync(path.join(dir, "eval/new.ts"), "x\n");
    commit();
    expect(heldTreeProblem(dir, decl, base)).toMatch(/eval\/new.ts/);
    git(dir, "rm", "-q", "eval/new.ts");
    fs.writeFileSync(path.join(dir, ".codecast/envs.toml"), "# changed\n");
    commit();
    expect(heldTreeProblem(dir, decl, base)).toMatch(/envs.toml/);
  });

  test("a symlinked node_modules is the install, not a change; an ignored file under a protected path is a change", () => {
    const { dir, base } = repo();
    fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n*.local\n");
    git(dir, "add", ".gitignore");
    git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "ignore");
    const install = fs.mkdtempSync(path.join(os.tmpdir(), "held-nm-"));
    fs.symlinkSync(install, path.join(dir, "node_modules"));
    expect(heldTreeProblem(dir, decl, base)).toBeNull();
    fs.writeFileSync(path.join(dir, "eval/override.local"), "dump()\n");
    expect(heldTreeProblem(dir, decl, base)).toMatch(/eval\/override.local/);
  });
});

describe("putCaseSet", () => {
  test("uploads in chunks and returns only the count and version", async () => {
    const { post, calls } = fakeServer();
    const text = JSON.stringify({ label: "frozen", meta: { seed: "s" }, cases: [{ id: "a", payload: { pitch: SECRET } }] });
    const out = await putCaseSet(post, "acme/x", "held", text, { scope: { workspace: "team", team_id: "t" } });
    expect(out).toMatchObject({ size: 1, workspace: "team:t" });
    expect(out.version).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(calls[0].body).toMatchObject({ env: "acme/x", split: "held", size: 1, label: "frozen", workspace: "team" });
  });

  test("refuses a malformed set before any call", async () => {
    const { post, calls } = fakeServer();
    await expect(putCaseSet(post, "acme/x", "held", JSON.stringify({ cases: [{ id: "a" }] }), {})).rejects.toThrow(/no payload/);
    expect(calls).toEqual([]);
  });
});

describe("putCaseSetMeta", () => {
  test("sends the meta only, as a deliberate replacement, and refuses a file that carries cases", async () => {
    const calls: any[] = [];
    const post = async (url: string, body: any) => { calls.push({ url, body: structuredClone(body) }); return { version: "2222222222222222", size: 3, workspace: "team:t" }; };
    const out = await putCaseSetMeta(post, "acme/x", "held", JSON.stringify({ meta: { calibration: { a: 1 } }, label: "recal" }), {});
    expect(out).toMatchObject({ version: "2222222222222222", size: 3 });
    expect(calls[0]).toMatchObject({ url: "/cli/envs/cases/put", body: { split: "held", keep_cases: true, replace: true, meta: JSON.stringify({ calibration: { a: 1 } }), label: "recal", cases: [] } });
    await expect(putCaseSetMeta(post, "acme/x", "held", JSON.stringify({ meta: {}, cases: [{ id: "a", payload: 1 }] }), {})).rejects.toThrow(/\{ meta, label\? \}/);
  });
});

describe("what the CLI and web can print", () => {
  test("caseSetLines prints counts, versions and the log", () => {
    const lines = caseSetLines(plain, { dev: { version: "fedcba9876543210", size: 218, uploaded_at: 1, reads: 5, unfiled: 0 }, held: { version: "0123456789abcdef", size: 154, uploaded_at: 1, reads: 2, unfiled: 1, last_attempt: { short_id: "ea-4", candidate: "base", n: 60, mean: 0.41, finished_at: 2 } }, reads: [{ kind: "run", split: "held", version: "0123456789abcdef", by: "dev", session_id: "jx1", task_id: "ct-2", at: 3 }] }, () => "now").join("\n");
    expect(lines).toContain("154 cases");
    expect(lines).toContain("ea-4");
    expect(lines).toContain("jx1");
    expect(lines).toContain("1 with no attempt filed");
    expect(lines).toContain("Dev set 218 cases");
  });

  test("only envCases.ts reaches the fetch routes; no web source reaches the case-set functions", () => {
    const root = path.resolve(import.meta.dir, "../..");
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
          const text = fs.readFileSync(p, "utf8");
          if (/cases\/(open|page)|envCases\.(open|page)/.test(text)) hits.push(path.relative(root, p));
        }
      }
    };
    walk(path.join(root, "cli/src"));
    walk(path.join(root, "web"));
    expect(hits).toEqual(["cli/src/envCases.ts"]);
  });
});

describe("runWithCases", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cases-run-"));
  const runner = path.join(dir, "runner.js");
  // Reports, in its version, what it was handed: the file's split and size, local, or nothing.
  fs.writeFileSync(runner, `
const fs = require("fs");
const f = process.env.${CASES_FILE_ENV};
const v = f ? JSON.parse(fs.readFileSync(f, "utf8")).split + "-" + JSON.parse(fs.readFileSync(f, "utf8")).cases.length : process.env.${LOCAL_CASES_ENV} === "1" ? "local" : "none";
console.log(JSON.stringify({ env: "acme/x", env_version: v, level: "L2", candidate: { label: "base" }, split: "dev", cases: [{ id: "a", score: 1 }], summary: { n: 1, mean: 1 }, started_at: "2026-11-17T10:00:00Z", finished_at: "2026-11-17T10:00:01Z" }));
`);
  const decl: EnvDeclaration = { key: "acme/x", title: "x", level: "L2", command: `node ${runner}`, splits: ["dev"] };
  const server = (dev: boolean) => {
    const calls: string[] = [];
    const post = async (url: string, body: any) => {
      calls.push(`${url}:${body.split ?? ""}`);
      if (url === "/cli/envs/cases/open") {
        if (!dev) throw new Error("acme/x has no dev set in this workspace: the product's runner uploads one");
        return { read: "rd", version: "1111111111111111", size: 2 };
      }
      if (url === "/cli/envs/cases/page") return { cases: [{ id: "a", payload: "1" }, { id: "b", payload: "2" }], next: null };
      throw new Error(url);
    };
    return { post, calls };
  };
  const version = (r: { run: any }) => (r.run.ok ? r.run.result.env_version : r.run.error);

  test("a dev run gets codecast's dev set and the fetch to file against", async () => {
    const { post, calls } = server(true);
    const r = await runWithCases(post, decl, { dir, candidate: "base", split: "dev", quiet: true }, {});
    expect(version(r)).toBe("dev-2");
    expect(r.read).toBe("rd");
    expect(calls[0]).toBe("/cli/envs/cases/open:dev");
  });

  test("an env with no dev set here runs as before, with no file", async () => {
    const { post } = server(false);
    const r = await runWithCases(post, decl, { dir, candidate: "base", split: "dev", quiet: true }, {});
    expect(version(r)).toBe("none");
    expect(r.read).toBeUndefined();
  });

  test("--local-cases fetches nothing and tells the runner to read its own corpus", async () => {
    const { post, calls } = server(true);
    const r = await runWithCases(post, decl, { dir, candidate: "base", split: "dev", quiet: true, localCases: true }, {});
    expect(version(r)).toBe("local");
    expect(calls).toEqual([]);
  });

  test("a fetch that fails for another reason stops the run and names the local way", async () => {
    const post = async () => { throw new Error("network down"); };
    await expect(runWithCases(post, decl, { dir, candidate: "base", split: "dev", quiet: true }, {})).rejects.toThrow(/network down .*--local-cases/);
  });
});
