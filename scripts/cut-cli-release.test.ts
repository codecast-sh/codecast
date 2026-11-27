import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("./cut-cli-release.sh", import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(String(r.stderr));
  return String(r.stdout).trim();
};

/**
 * A main whose commits carry the given CLI versions (oldest first), and gh/curl/cast stubs that log what they were
 * asked. `green(poll)` names the commits (by index) CI passed as of that poll of ci.yml.
 */
function world(opts: { versions: string[]; busyPolls?: number; green?: (poll: number) => number[]; latest?: (shas: string[]) => object }) {
  const root = mkdtempSync(join(tmpdir(), "cut-cli-"));
  dirs.push(root);
  const repo = join(root, "repo");
  git(root, "init", "-q", "--bare", "origin.git");
  git(root, "clone", "-q", "origin.git", "repo");
  git(repo, "checkout", "-q", "-b", "main");
  mkdirSync(join(repo, "packages/cli"), { recursive: true });
  const shas: string[] = [];
  opts.versions.forEach((version, i) => {
    writeFileSync(join(repo, "packages/cli/package.json"), JSON.stringify({ name: "cli", version }));
    writeFileSync(join(repo, "change"), String(i));
    git(repo, "add", ".");
    git(repo, "commit", "-qm", `c${i}`);
    shas.push(git(repo, "rev-parse", "HEAD"));
  });
  git(repo, "push", "-q", "origin", "main");
  const green = opts.green ?? (() => shas.map((_, i) => i));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const greenDir = join(root, "green");
  mkdirSync(greenDir);
  for (let poll = 0; poll < 20; poll++) writeFileSync(join(greenDir, String(poll)), green(poll).map((i) => shas[i]).reverse().join("\n"));
  const log = join(root, "log");
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> ${log}\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("gh", `
if [[ "$1 $2" == "run list" && "$*" == *finalize* ]]; then
  n=$(cat ${root}/busy 2>/dev/null || echo 0); echo $((n+1)) > ${root}/busy
  (( n < ${opts.busyPolls ?? 0} )) && printf '45910754244 '
fi
if [[ "$1 $2" == "run list" && "$*" == *ci.yml* ]]; then
  n=$(cat ${root}/ci 2>/dev/null || echo 0); echo $((n+1)) > ${root}/ci
  cat ${greenDir}/$(( n < 19 ? n : 19 ))
fi
[[ "$1 $2" == "run list" && "$*" == *url* ]] && echo https://github.com/codecast-sh/codecast/actions/runs/1
exit 0`);
  stub("curl", `echo '${JSON.stringify(opts.latest?.(shas) ?? {})}'`);
  stub("cast", "exit 0");
  const run = (env: Record<string, string> = {}) => {
    const r = Bun.spawnSync(["bash", SCRIPT], {
      cwd: repo,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CUT_POLL_SECONDS: "0", CUT_DISPATCH_SETTLE_SECONDS: "0", ...env },
    });
    let calls = "";
    try { calls = readFileSync(log, "utf-8"); } catch {}
    return { code: r.exitCode, out: String(r.stdout) + String(r.stderr), calls };
  };
  return { shas, run };
}

const cutOf = (calls: string) => calls.match(/gh workflow run cut-cli-release\.yml -R \S+ -f source_commit=([0-9a-f]{40})/)?.[1] ?? null;

describe("the cli send (ct-102056)", () => {
  test("with nothing in flight it cuts main's newest green commit and names the cut run", () => {
    const w = world({ versions: ["1.0.0", "1.0.1", "1.0.1"] });
    const r = w.run();
    expect(r.code).toBe(0);
    expect(cutOf(r.calls)).toBe(w.shas[2]);
    expect(r.out).toContain("actions/runs/1");
  });

  test("a release in flight is waited for, then a release is cut, and no other run's url is printed", () => {
    const w = world({ versions: ["1.0.0", "1.0.0"], busyPolls: 2, latest: () => ({ version: "1.0.0", sourceCommit: "0".repeat(40) }) });
    const r = w.run({ CAST_DEPLOY_SHA: w.shas[1], CAST_DEPLOY_ID: "dp-9" });
    expect(r.code).toBe(0);
    expect(r.out.match(/Waiting for the CLI release in flight/g)?.length).toBe(2);
    expect(r.out.match(/https:\/\/github\.com\S+/g)).toEqual(["https://github.com/codecast-sh/codecast/actions/runs/1"]);
    expect(cutOf(r.calls)).toBe(w.shas[1]);
    expect(r.calls).not.toContain("cast ship mark");
  });

  test("when the public release already holds its commit, the deploy is recorded live there and nothing is cut", () => {
    const w = world({ versions: ["1.0.0", "1.0.0"], busyPolls: 1, latest: (shas) => ({ version: "1.0.5", sourceCommit: shas[1] }) });
    const r = w.run({ CAST_DEPLOY_SHA: w.shas[0], CAST_DEPLOY_ID: "dp-9" });
    expect(r.code).toBe(0);
    expect(r.calls).toContain(`cast ship mark --surface cli --sha ${w.shas[1]} --version 1.0.5 --deploy dp-9`);
    expect(r.calls).not.toContain("gh workflow run");
  });

  test("a release still in flight past the wait fails the send without cutting", () => {
    const w = world({ versions: ["1.0.0"], busyPolls: 100 });
    const r = w.run({ CUT_WAIT_SECONDS: "0" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Still waiting for the CLI release in flight");
    expect(r.calls).not.toContain("gh workflow run");
  });

  test("main's head with no verdict (its run cancelled by a newer push) is skipped for the newest green commit that carries the deploy", () => {
    const w = world({ versions: ["1.0.1", "1.0.1", "1.0.1", "1.0.1"], green: () => [0, 2] });
    const r = w.run({ CAST_DEPLOY_SHA: w.shas[1], CAST_DEPLOY_ID: "dp-9" });
    expect(r.code).toBe(0);
    expect(cutOf(r.calls)).toBe(w.shas[2]);
  });

  test("with no green commit carrying the deploy yet, the send waits until one goes green", () => {
    const w = world({ versions: ["1.0.1", "1.0.1", "1.0.1"], green: (poll) => (poll < 2 ? [0] : [0, 2]) });
    const r = w.run({ CAST_DEPLOY_SHA: w.shas[1], CAST_DEPLOY_ID: "dp-9" });
    expect(r.code).toBe(0);
    expect(r.out.match(/Waiting for a green CI verdict/g)?.length).toBe(2);
    expect(cutOf(r.calls)).toBe(w.shas[2]);
  });

  test("a green commit from before the last version bump is never cut, and the send gives up when none comes", () => {
    const w = world({ versions: ["1.0.0", "1.0.1", "1.0.1"], green: () => [0] });
    const r = w.run({ CUT_WAIT_SECONDS: "0" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Still waiting for a green CI verdict on a main commit after the last version bump");
    expect(r.calls).not.toContain("gh workflow run");
  });
});
