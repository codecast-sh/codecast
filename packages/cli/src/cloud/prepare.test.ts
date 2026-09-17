import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { agentLoginsBundleFor, armInterruptGuard, fetchRootOccupant, freshWorktreeName, parseAcquireOutput, parseStartFrom, pushAgentLoginsNow, readyHostHome, remoteRepoPath, resolveSeedRoots, ROOT_WORKSPACE_NAME, sameGitOrigin, seedBranchNames, toolsForPrepare } from "./prepare";
import { checkoutRefusal, cloudSeedRef, CloudSeedNameError, finishSeededWorktree } from "./transfer";
import { NODE_22_VERSION, type HostToolsReport } from "./hostTools";
import { cloudStartArgs, cloudStartSkipReason, launchModelKey, parkedRowStillPending, seedPlacementArg } from "./cli";

const host = { address: "1.2.3.4", user: "ubuntu", keyPath: "/k", remoteBaseDir: "/home/ubuntu/work", homeDir: "/home/ubuntu" };

describe("remoteRepoPath", () => {
  test("the repo lands under the host's work dir with the local basename", () => {
    expect(remoteRepoPath(host, "/Users/a/src/codecast")).toBe("/home/ubuntu/work/codecast");
  });
});

describe("freshWorktreeName", () => {
  test("cloud-<6 hex>, distinct per call", () => {
    const a = freshWorktreeName();
    expect(a).toMatch(/^cloud-[0-9a-f]{6}$/);
    expect(freshWorktreeName()).not.toBe(a);
  });
});

describe("parseAcquireOutput — the host's `cast ws acquire --json`", () => {
  const ok = JSON.stringify({ name: "cloud-1", path: "/home/ubuntu/work/r/.codecast/worktrees/cloud-1", branch: "codecast/cloud-1", state: "ready", ports: { web: 3221 }, created: true, contract: { ok: true, failures: [] } });
  test("takes the last JSON line after install noise", () => {
    const ws = parseAcquireOutput("cloud-1", `bun install v1.3\n+ 400 packages installed\n${ok}\n`);
    expect(ws).toEqual({ name: "cloud-1", path: "/home/ubuntu/work/r/.codecast/worktrees/cloud-1", branch: "codecast/cloud-1", ports: { web: 3221 }, created: true });
  });
  test("no JSON, or a broken contract, is an error that names the worktree", () => {
    expect(() => parseAcquireOutput("cloud-2", "acquire failed: boom")).toThrow(/cloud-2 printed no JSON/);
    const broken = JSON.stringify({ name: "cloud-3", path: "/p", branch: "b", state: "broken", ports: {}, created: true, contract: { ok: false, failures: [{ name: "deps-installed" }] } });
    expect(() => parseAcquireOutput("cloud-3", broken)).toThrow(/cloud-3 on the host is broken/);
  });
  test.each([
    { name: "someone-else" }, { state: "creating" }, { state: "broken" },
    { contract: null }, { contract: { ok: "true", failures: [] } },
    { contract: { ok: true } }, { contract: { ok: true, failures: ["failed"] } },
    { path: "relative/path" }, { path: "/" }, { path: "/p/../escape" }, { path: "/p\n" },
    { branch: "" }, { branch: "bad branch" }, { created: "true" },
    { ports: null }, { ports: [] }, { ports: { web: 0 } }, { ports: { web: 65536 } },
    { ports: { web: 1.5 } }, { ports: { web: "3221" } },
  ])("rejects malformed or unsuccessful acquisition: %j", (bad) => {
    expect(() => parseAcquireOutput("cloud-1", JSON.stringify({ ...JSON.parse(ok), ...bad }))).toThrow();
  });
  test("accepts ready existing workspaces and valid port bounds", () => {
    expect(parseAcquireOutput("cloud-1", JSON.stringify({ ...JSON.parse(ok), created: false, ports: { a: 1, z: 65535 } })).created).toBe(false);
  });
  test("does not expose output contents in JSON errors", () => {
    expect(() => parseAcquireOutput("cloud-1", "SECRET_VALUE")).toThrow("cloud-1 printed no JSON");
    expect(() => parseAcquireOutput("cloud-1", '{"SECRET_VALUE"')).toThrow("cloud-1 printed invalid JSON");
  });
});

describe("launchModelKey — the row's model id back to the launch option key", () => {
  test("claude rows carry claude-<key>; other agents keep the id", () => {
    expect(launchModelKey("claude-opus", "claude_code")).toBe("opus");
    expect(launchModelKey("gpt-5", "codex")).toBe("gpt-5");
    expect(launchModelKey(null, "claude_code")).toBeUndefined();
  });
});

describe("parkedRowStillPending — `cast cloud start` only places a row still waiting", () => {
  test("pending is ours to prepare; anything else was re-pointed or placed already", () => {
    expect(parkedRowStillPending({ cloud_placement: "pending" })).toBe(true);
    expect(parkedRowStillPending({ cloud_placement: null })).toBe(false);
    expect(parkedRowStillPending({})).toBe(false);
    expect(parkedRowStillPending({ cloud_placement: undefined })).toBe(false);
  });

  test("cloudStartSkipReason: a pathless park is a clean skip, not a failure to stamp on the row", () => {
    expect(cloudStartSkipReason({ cloud_placement: "pending", git_root: "/Users/me/app" })).toBeNull();
    expect(cloudStartSkipReason({ cloud_placement: "pending", project_path: "/Users/me/app" })).toBeNull();
    expect(cloudStartSkipReason({ cloud_placement: "pending" })).toBe("no_path");
    expect(cloudStartSkipReason({ cloud_placement: "pending", project_path: null, git_root: null })).toBe("no_path");
    expect(cloudStartSkipReason({ cloud_placement: null, project_path: "/Users/me/app" })).toBe("not_pending");
  });
});

describe("agent logins step (readyHostHome step 1)", () => {
  let dir: string, home: string;
  let savedEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    savedEnv = { ...process.env };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-logins-"));
    home = path.join(dir, "home");
    fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
    process.env.HOME = home;
    process.env.CODECAST_DIR = path.join(home, ".codecast");
    // The login sources read CODEX_HOME before HOME; a pinned or real one must not leak in.
    delete process.env.CODEX_HOME;
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sources = () => ({ home, now: 1_700_000_000_000, deviceId: "dev1" });
  const config = { user_id: "u1", auth_token: "t", convex_url: "https://x" } as any;

  test("agentLoginsBundleFor: codexTrustPaths is exactly [remoteRepoPath(host, localGitRoot)] and nothing else is path-derived", () => {
    const { bundle } = agentLoginsBundleFor(host, "/Users/a/src/codecast", { ...sources(), userId: "u1" });
    expect(bundle.codexTrustPaths).toEqual([remoteRepoPath(host, "/Users/a/src/codecast")]);
    expect(bundle.files).toEqual([]);
    expect(bundle.claudeEnv).toEqual({});
    expect(JSON.stringify(bundle)).not.toContain("/Users/a");
    expect(agentLoginsBundleFor(host, undefined, { ...sources(), userId: "u1" }).bundle.codexTrustPaths).toEqual([]);
  });

  test("pushAgentLoginsNow: every source skipped still pushes a files=[] bundle, non-fatally, and reports the Claude push beside it", () => {
    fs.mkdirSync(path.join(home, ".codex"));
    fs.writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: null, tokens: {} }));
    const pushed: unknown[] = [];
    const lines: string[] = [];
    const r = pushAgentLoginsNow(host, {
      localGitRoot: "/Users/a/src/codecast", config, onProgress: (m) => lines.push(m),
      deps: { pushClaude: () => ({ pushed: false, reason: "no credential" }), push: (_h, b) => { pushed.push(b); return { pushed: true, kept: [], files: 0, deleted: 5, env: [], trust: 1 }; }, sources },
    });
    expect(r.pushed).toBe(true);
    expect(r.skipped).toEqual([{ id: "codex", reason: "logged-out stub" }]);
    expect(r.claude).toEqual({ pushed: false, reason: "no credential" });
    expect(pushed).toHaveLength(1);
    expect((pushed[0] as any).files).toEqual([]);
    expect((pushed[0] as any).codexTrustPaths).toEqual(["/home/ubuntu/work/codecast"]);
    expect(lines).toContain("codex login not pushed: logged-out stub — run codex login on this machine");
    expect(lines.some((l) => l.startsWith("agent logins pushed: no logins, trust 1"))).toBe(true);
  });

  test("pushAgentLoginsNow: a refusal, a throwing push and a logged-out laptop are outcomes, not throws", () => {
    const refused = pushAgentLoginsNow(host, { config, deps: { pushClaude: () => ({ pushed: true }), push: () => ({ pushed: false, kept: [], reason: "host holds another user's logins" }), sources } });
    expect(refused).toMatchObject({ pushed: false, reason: "host holds another user's logins" });
    const threw = pushAgentLoginsNow(host, { config, deps: { pushClaude: () => { throw new Error("ssh down"); }, push: () => { throw new Error("boom"); }, sources } });
    expect(threw.pushed).toBe(false);
    expect(threw.reason).toBe("boom");
    expect(threw.claude.reason).toMatch(/ssh down/);
    const loggedOut = pushAgentLoginsNow(host, { config: null, deps: { pushClaude: () => ({ pushed: true }), push: () => { throw new Error("must not be called"); }, sources } });
    expect(loggedOut.pushed).toBe(false);
    expect(loggedOut.reason).toMatch(/not logged in/);
  });

  test("pushAgentLoginsNow: a kept codex blob is logged with the re-login hint", () => {
    const lines: string[] = [];
    const r = pushAgentLoginsNow(host, { config, onProgress: (m) => lines.push(m), deps: { pushClaude: () => ({ pushed: true }), push: () => ({ pushed: true, kept: ["codex host-fresher"], files: 0, deleted: 0, env: [], trust: 0 }), sources } });
    expect(r.kept).toEqual(["codex host-fresher"]);
    expect(lines.some((l) => l.startsWith("codex host-fresher — the host's copy is newer; run codex login"))).toBe(true);
  });

  test("readyHostHome merges the tools JSON into the report and stays non-fatal when the script fails", async () => {
    const tools: HostToolsReport = { ok: [{ tool: "node", version: "v22.12.0" }], installed: [{ tool: "gh" }], missing: [{ tool: "uv", referenced_by: "skills" }], unsupported: [], install: true };
    const lines: string[] = [];
    const mirrorDeps = async () => ({ pushed: true, changed: 0, hash: "abcdef1234" });
    const report = await readyHostHome(host, {
      skipGit: true, onProgress: (m) => lines.push(m), localGitRoot: "/Users/a/src/codecast", mirrorDeps,
      loginsDeps: { pushClaude: () => ({ pushed: true }), push: () => ({ pushed: true, kept: [], files: 0, deleted: 0, env: [], trust: 1 }), sources },
      toolsDeps: { required: () => ({ node: { minMajor: 20, install: NODE_22_VERSION, source: "x" }, clients: {}, tools: [], unsupported: [] }), run: () => tools },
    });
    expect(report.tools).toEqual(tools);
    expect(report.logins?.pushed).toBe(false); // no CODECAST_DIR config → not logged in; the step still ran
    expect(report.mirror).toBe("mirrored 0 changed config file(s) (abcdef12)");
    expect(lines).toContain("host tools: 1 ok, 1 installed, 1 missing, 0 unsupported (installed gh)");
    expect(lines).toContain("host tools: missing uv (for skills)");
    const failed = await readyHostHome(host, {
      skipGit: true, onProgress: (m) => lines.push(m), mirrorDeps,
      loginsDeps: { pushClaude: () => ({ pushed: true }), push: () => ({ pushed: true, kept: [], files: 0, deleted: 0, env: [], trust: 0 }), sources },
      toolsDeps: { required: () => { throw new Error("no repo"); }, run: () => tools },
    });
    expect(failed.tools).toBeUndefined();
    expect(lines).toContain("host tools check skipped: no repo");
    expect(toolsForPrepare(host, () => {}, { deps: { required: () => ({ node: { minMajor: 20, install: NODE_22_VERSION, source: "x" }, clients: {}, tools: [], unsupported: [] }), run: () => { throw new Error("ssh: Connection refused"); } } })).toBeUndefined();
  });

  test("readyHostHome with skipLogins runs neither the push nor the tools check", async () => {
    const report = await readyHostHome(host, {
      skipGit: true, skipLogins: true, mirrorDeps: async () => ({ pushed: true, changed: 0, hash: "abcdef1234" }),
      loginsDeps: { push: () => { throw new Error("must not run"); }, pushClaude: () => { throw new Error("must not run"); }, sources },
      toolsDeps: { required: () => { throw new Error("must not run"); } },
    });
    expect(report.logins).toBeUndefined();
    expect(report.tools).toBeUndefined();
  });
});

describe("shared checkout helpers (ct-49428)", () => {
  test("checkoutRefusal: dirty lists the files (five at most); detached + unreachable is an orphan; contained or on a branch is fine", () => {
    expect(checkoutRefusal({ dirty: [" M app.txt", "?? new.txt"], headRef: "main", containedBy: true }, "/home/ubuntu/work/app"))
      .toBe("host checkout /home/ubuntu/work/app has uncommitted changes ( M app.txt, ?? new.txt) — commit, stash or reset them on the host, or run isolated");
    const many = checkoutRefusal({ dirty: ["a", "b", "c", "d", "e", "f", "g"], headRef: "main", containedBy: true })!;
    expect(many).toContain("(a, b, c, d, e, … 2 more)");
    expect(checkoutRefusal({ dirty: [], headRef: "HEAD", containedBy: false })).toBe("host checkout is detached at commits no branch holds — create a branch for them on the host first");
    expect(checkoutRefusal({ dirty: [], headRef: "HEAD", containedBy: true })).toBeNull();
    expect(checkoutRefusal({ dirty: [], headRef: "codecast/cloud-1", containedBy: false })).toBeNull();
  });

  test("cloudStartArgs: the daemon's argv carries --device and a valid --workspace only", () => {
    expect(cloudStartArgs({ conversation_id: "c1" })).toEqual(["cloud", "start", "c1"]);
    expect(cloudStartArgs({ conversation_id: "c1", cloud_device_id: "box", workspace: "shared" })).toEqual(["cloud", "start", "c1", "--device", "box", "--workspace", "shared"]);
    expect(cloudStartArgs({ conversation_id: "c1", workspace: "isolated" })).toEqual(["cloud", "start", "c1", "--workspace", "isolated"]);
    expect(cloudStartArgs({ conversation_id: "c1", cloud_device_id: null, workspace: "garbage" })).toEqual(["cloud", "start", "c1"]);
  });

  test("parseAcquireOutput accepts the shared-checkout record with the root as its path", () => {
    const out = JSON.stringify({ name: ROOT_WORKSPACE_NAME, path: "/home/ubuntu/work/r", branch: "codecast/cloud-abc123", state: "ready", ports: { web: 3221 }, created: false, contract: { ok: true, failures: [] } });
    expect(parseAcquireOutput(ROOT_WORKSPACE_NAME, `bun install v1\n${out}\n`)).toEqual({ name: ROOT_WORKSPACE_NAME, path: "/home/ubuntu/work/r", branch: "codecast/cloud-abc123", ports: { web: 3221 }, created: false });
  });

  test("fetchRootOccupant applies the shared rule to cloud.hostSessions and honours excludeId", async () => {
    const rows = [
      { conversation_id: "conv_iso", short_id: "iso0001", title: "isolated", status: "active", cloud_workspace: "isolated", project_path: "/home/ubuntu/work/r/.codecast/worktrees/x" },
      { conversation_id: "conv_sh", short_id: "sh00001", title: "shared one", status: "active", cloud_workspace: "shared", cloud_checkout_path: "/home/ubuntu/work/r", project_path: "/home/ubuntu/work/r" },
    ];
    const queries: unknown[] = [];
    const client = { query: async (_fn: unknown, args: unknown) => { queries.push(args); return rows; } };
    const api = { cloud: { hostSessions: "hostSessions" } };
    expect(await fetchRootOccupant(client, api, "tok", "box", "/home/ubuntu/work/r")).toEqual({ conversation_id: "conv_sh", short_id: "sh00001", title: "shared one" });
    expect(queries).toEqual([{ api_token: "tok", device_id: "box" }]);
    expect(await fetchRootOccupant(client, api, "tok", "box", "/home/ubuntu/work/r", "conv_sh")).toBeNull();
    expect(await fetchRootOccupant(client, api, "tok", "box", "/home/ubuntu/work/other")).toBeNull();
    // hostSessions returns session_error as a boolean: a failed pending claim frees the root through it.
    const failed = [{ ...rows[1], cloud_placement: "pending", session_error: true }];
    const failedClient = { query: async () => failed };
    expect(await fetchRootOccupant(failedClient, api, "tok", "box", "/home/ubuntu/work/r")).toBeNull();
  });

  test("armInterruptGuard records the first signal for the caller to stamp, and disarms cleanly", () => {
    const before = process.listenerCount("SIGINT");
    const guard = armInterruptGuard(["SIGINT"]);
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    expect(guard.reason()).toBeNull();
    process.emit("SIGINT" as any);
    expect(guard.reason()).toBe("spawn interrupted (SIGINT)");
    guard.disarm();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  test("prepareCloudHost is fetch-only: it refreshes with moveHead:false, and only the shared path passes moveHead:true", () => {
    const prepare = fs.readFileSync(path.join(import.meta.dir, "prepare.ts"), "utf-8");
    const body = prepare.slice(prepare.indexOf("export async function prepareCloudHost("), prepare.indexOf("export async function fetchRootOccupant("));
    expect(body).toContain("refreshCloudCheckout(prepared, { moveHead: false }, log)");
    expect(body).not.toContain("moveHead: true");
    const cli = fs.readFileSync(path.join(import.meta.dir, "cli.ts"), "utf-8");
    const shared = cli.slice(cli.indexOf('if (mode === "shared") {'), cli.indexOf("const prepared = await prepareCloudHost("));
    // Claim before any checkout mutation, then the HEAD move, then the root record.
    expect(shared.indexOf("api.cloud.claimSharedCheckout")).toBeGreaterThan(shared.indexOf("await wakeCloudHost("));
    expect(shared.indexOf("refreshCloudCheckout(prepared, { moveHead: true }, say)")).toBeGreaterThan(shared.indexOf("api.cloud.claimSharedCheckout"));
    expect(shared.indexOf("acquireRemoteRootCheckout(")).toBeGreaterThan(shared.indexOf("refreshCloudCheckout(prepared, { moveHead: true }, say)"));
    const index = fs.readFileSync(path.join(import.meta.dir, "../index.ts"), "utf-8");
    const spawn = index.slice(index.indexOf("if (cloud && options.shared) {"), index.indexOf("for (const prompt of cloud && options.shared ? [] : prompts)"));
    expect(spawn.indexOf('cloud_workspace: "shared"')).toBeLessThan(spawn.indexOf("refreshCloudCheckout(cloud.prepared, { moveHead: true }, say)"));
  });

  test("the checkout's origin follows the credential the host git step proved, and cloud start reports which one pushes", () => {
    // Network-free pins on the two places the App token fact travels: into
    // the origin spelling the host checkout gets, and out to the JSON a
    // caller reads to learn whether this host can push at all.
    const prepare = fs.readFileSync(path.join(import.meta.dir, "prepare.ts"), "utf-8");
    const refresh = prepare.slice(prepare.indexOf("export function refreshCloudCheckout("), prepare.indexOf("export async function seedForHost("));
    expect(refresh).toContain("appToken: prepared.git?.app?.write === true");
    const cli = fs.readFileSync(path.join(import.meta.dir, "cli.ts"), "utf-8");
    const report = cli.slice(cli.indexOf("const gitAccess = ("), cli.indexOf('if (mode === "shared") {'));
    expect(report).toContain("hostAccessPath(git.access, git.app, prepared.cloud.forwardAgent === true)");
    expect(report).toContain("path,");
  });
});

describe("the laptop seed's pure parts (ct-49433)", () => {
  test("seedBranchNames: the laptop branch first, then <branch>-<hex>; detached → codecast/<name>; invalid names rejected", () => {
    expect(seedBranchNames("feat/x", "cloud-ab12cd")).toEqual({ primary: "feat/x", alt: "feat/x-ab12cd" });
    expect(seedBranchNames("main", "cloud-ab12cd")).toEqual({ primary: "main", alt: "main-ab12cd" });
    expect(seedBranchNames("feat/x", "nodash")).toEqual({ primary: "feat/x", alt: "feat/x-nodash" });
    expect(seedBranchNames(undefined, "cloud-ab12cd")).toEqual({ primary: "codecast/cloud-ab12cd" });
    expect(seedBranchNames("HEAD", "cloud-ab12cd")).toEqual({ primary: "codecast/cloud-ab12cd" });
    expect(() => seedBranchNames("bad branch", "cloud-1")).toThrow(/not a usable branch name/);
    expect(() => seedBranchNames("x..y", "cloud-1")).toThrow(/not a usable branch name/);
  });

  test("cloudSeedRef: git's own refname check, before any ssh", () => {
    expect(cloudSeedRef("cloud-ab12cd")).toBe("refs/codecast/cloud/cloud-ab12cd");
    for (const bad of ["a..b", "x.lock", "bad name", "-dash", ""]) expect(() => cloudSeedRef(bad)).toThrow(CloudSeedNameError);
  });

  test("resolveSeedRoots: the worktree is the seed, the main repo names the host checkout; outside a repo both are the cwd", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seed-roots-")));
    try {
      const main = path.join(dir, "main repo");
      execFileSync("git", ["init", "-q", "-b", "main", main]);
      execFileSync("git", ["-C", main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root"]);
      const linked = path.join(dir, "linked");
      execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "feat/l", linked]);
      fs.mkdirSync(path.join(linked, "sub"));
      expect(resolveSeedRoots(path.join(linked, "sub"))).toEqual({ seedCwd: linked, repoRoot: main });
      expect(resolveSeedRoots(main)).toEqual({ seedCwd: main, repoRoot: main });
      const plain = path.join(dir, "plain");
      fs.mkdirSync(plain);
      expect(resolveSeedRoots(plain)).toEqual({ seedCwd: plain, repoRoot: plain });
      // A submodule's common dir is <super>/.git/modules/<name>: the submodule itself is the repo, not "modules".
      const sub = path.join(dir, "sub");
      execFileSync("git", ["init", "-q", "-b", "main", sub]);
      execFileSync("git", ["-C", sub, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "sub"]);
      execFileSync("git", ["-C", main, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub"]);
      expect(resolveSeedRoots(path.join(main, "sub"))).toEqual({ seedCwd: path.join(main, "sub"), repoRoot: path.join(main, "sub") });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parseStartFrom accepts both spellings and rejects garbage; sameGitOrigin ignores scheme, user, .git and slashes", () => {
    expect(parseStartFrom(undefined)).toBe("checkout");
    expect(parseStartFrom("checkout")).toBe("checkout");
    expect(parseStartFrom("origin-main")).toBe("origin_main");
    expect(parseStartFrom("origin_main")).toBe("origin_main");
    expect(() => parseStartFrom("trunk")).toThrow(/--from takes checkout or origin-main/);
    expect(sameGitOrigin("https://github.com/o/r.git", "git@github.com:o/r")).toBe(true);
    expect(sameGitOrigin("ssh://git@github.com/o/r.git", "https://github.com/o/r/")).toBe(true);
    expect(sameGitOrigin("git@github.com:o/r.git", "git@github.com:o/other.git")).toBe(false);
    expect(sameGitOrigin("/local/path", "/local/path/")).toBe(true);
    expect(sameGitOrigin(null, "git@github.com:o/r.git")).toBe(true);
  });

  test("cloudStartArgs carries --from for a known start_from only; seedPlacementArg maps a CloudSeed to the mutation shape", () => {
    expect(cloudStartArgs({ conversation_id: "c1", start_from: "checkout" })).toEqual(["cloud", "start", "c1", "--from", "checkout"]);
    expect(cloudStartArgs({ conversation_id: "c1", workspace: "isolated", start_from: "origin_main" })).toEqual(["cloud", "start", "c1", "--workspace", "isolated", "--from", "origin-main"]);
    expect(cloudStartArgs({ conversation_id: "c1", start_from: "trunk" })).toEqual(["cloud", "start", "c1"]);
    expect(seedPlacementArg({ source: "checkout", base: "a".repeat(40), branch: "feat/x", dirty: true, laptopRoot: "/Users/me/app", deviceId: "dev1", ref: "refs/codecast/cloud/x", snapshot: "b".repeat(40), tree: "c".repeat(40) }))
      .toEqual({ source: "checkout", base: "a".repeat(40), branch: "feat/x", dirty: true, laptop_root: "/Users/me/app", device_id: "dev1" });
    expect(seedPlacementArg({ source: "origin_main", base: "a".repeat(40), reason: "no repo" })).toEqual({ source: "origin_main", base: "a".repeat(40), reason: "no repo" });
  });

  test("finishSeededWorktree refuses a non-sha base before any ssh", () => {
    const seed = { source: "checkout" as const, base: "abc1234", snapshot: "b".repeat(40), tree: "c".repeat(40), ref: "refs/codecast/cloud/x" };
    expect(() => finishSeededWorktree(host, "/home/ubuntu/work/r/.codecast/worktrees/x", seed)).toThrow("missing a full sha");
    expect(() => finishSeededWorktree(host, "relative", { ...seed, base: "a".repeat(40) })).toThrow("normalized absolute path");
  });
});
