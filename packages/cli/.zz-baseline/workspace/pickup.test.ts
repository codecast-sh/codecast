import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWipSnapshot, pushWipSnapshot } from "../wipSnapshot.js";
import { acquireWorkspace, releaseWorkspace } from "./lifecycle.js";
import { fetchPickupConversation, PickupError, pickupBranches, preparePickup } from "./pickup.js";

// `cast ws acquire --from <session>` against real git: a bare "origin", the
// session's clone that the daemon snapshots, and a teammate's clone that picks
// the tree up. The snapshot is made and pushed by the daemon's own functions.

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const opts = { skipSetup: true, skipHooks: true, skipBrowser: true, skipPool: true, noPorts: true, agentDriven: false };
setDefaultTimeout(60_000); // real git clones; slow under load
const CONV = "jx7pickupfixture0000000000000000";
const REMOTE_URL = "git@github.com:acme/widgets.git";

let tmp: string;
let origin: string;
let theirs: string;
let mine: string;
let savedDir: string | undefined;

function clone(name: string): string {
  const dir = path.join(tmp, name);
  execFileSync("git", ["clone", "-q", origin, dir], { stdio: "ignore" });
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  return dir;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ws-pickup-")));
  savedDir = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = path.join(tmp, "state");
  origin = path.join(tmp, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = clone("seed");
  fs.writeFileSync(path.join(seed, "a.txt"), "one\n");
  fs.writeFileSync(path.join(seed, "gone.txt"), "delete me\n");
  fs.writeFileSync(path.join(seed, ".gitignore"), ".env\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "main");
  theirs = clone("theirs");
  mine = clone("mine");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedDir === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = savedDir;
});

/** The session's machine: a branch with a commit, an edit, a delete, an untracked file and a secret, snapshotted and pushed. */
async function publishTheirWork(): Promise<string> {
  git(theirs, "checkout", "-qb", "feat/widget");
  fs.writeFileSync(path.join(theirs, "a.txt"), "one\ntwo\n");
  git(theirs, "commit", "-qam", "unpushed commit");
  fs.writeFileSync(path.join(theirs, "a.txt"), "one\ntwo\nthree (uncommitted)\n");
  fs.rmSync(path.join(theirs, "gone.txt"));
  fs.writeFileSync(path.join(theirs, "new.txt"), "untracked\n");
  fs.writeFileSync(path.join(theirs, ".env"), "SECRET=1\n");
  const snap = await createWipSnapshot(theirs);
  expect(snap?.dirty).toBe(true);
  const pushed = await pushWipSnapshot(theirs, { remote: "origin", conversationIds: [CONV], sha: snap!.sha });
  expect(pushed.ok).toBe(true);
  return git(theirs, "rev-parse", "HEAD");
}

const conversation = (over: Partial<{ remoteUrl: string | null; updatedAt: string }> = {}) => ({
  id: CONV,
  remoteUrl: REMOTE_URL,
  updatedAt: new Date().toISOString(),
  ...over,
});

describe("preparePickup", () => {
  test("fetches the session's snapshot and acquire lands it as uncommitted work on the session's branch", async () => {
    const theirHead = await publishTheirWork();
    const s = await preparePickup(mine, conversation({ remoteUrl: null }));
    expect(s).toMatchObject({ branch: "feat/widget", base: theirHead, files: 3 });
    expect(s.warnings.join()).toContain("recorded no repository");

    const { branch, altBranch } = pickupBranches(s, CONV);
    const r = await acquireWorkspace(mine, "pick", { ...opts, branch, altBranch, startPoint: s.ref });
    const wt = r.workspace.path;
    expect(r.workspace.branch).toBe("feat/widget");
    expect(git(wt, "rev-parse", "HEAD")).toBe(theirHead);
    expect(git(wt, "status", "--porcelain")).toBe(git(theirs, "status", "--porcelain"));
    expect(fs.readFileSync(path.join(wt, "a.txt"), "utf-8")).toBe("one\ntwo\nthree (uncommitted)\n");
    expect(fs.existsSync(path.join(wt, ".env"))).toBe(false); // gitignored secrets never travel
  });

  test("a session branch that already exists here falls back to a branch named for the session", async () => {
    await publishTheirWork();
    git(mine, "branch", "feat/widget");
    const s = await preparePickup(mine, conversation({ remoteUrl: null }));
    const r = await acquireWorkspace(mine, "pick", { ...opts, ...pickupBranches(s, CONV), startPoint: s.ref });
    expect(r.workspace.branch).toBe(`feat/widget-pickup-${CONV.slice(0, 7)}`);
    expect(git(r.workspace.path, "status", "--porcelain")).toContain("?? new.txt");
  });

  test("releasing an untouched pickup drops its branch and the fetched snapshot ref", async () => {
    await publishTheirWork();
    const s = await preparePickup(mine, conversation({ remoteUrl: null }));
    await acquireWorkspace(mine, "pick", { ...opts, ...pickupBranches(s, CONV), startPoint: s.ref });
    await releaseWorkspace(mine, "pick");
    expect(git(mine, "for-each-ref", "--format=%(refname)", "refs/heads/feat/", "refs/codecast/")).toBe("");
  });

  test("no snapshot on the remote says so", async () => {
    const err = await preparePickup(mine, conversation({ remoteUrl: null })).catch((e) => e);
    expect(err).toBeInstanceOf(PickupError);
    expect(err.message).toContain("no snapshot of session jx7pick on origin");
  });

  test("a session in another repository is refused before anything is fetched", async () => {
    await publishTheirWork();
    git(mine, "remote", "set-url", "origin", "git@github.com:acme/other.git");
    const err = await preparePickup(mine, conversation()).catch((e) => e);
    expect(err.message).toContain("ran in acme/widgets, but this checkout is acme/other");
  });

  test("a long-idle session warns and still picks up", async () => {
    await publishTheirWork();
    const s = await preparePickup(mine, conversation({ remoteUrl: null, updatedAt: new Date(Date.now() - 50 * 3_600_000).toISOString() }));
    expect(s.warnings.join()).toContain("idle 50 hours");
  });

  test("a snapshot that records when it was taken reports it, and warns when that is old", async () => {
    const head = git(theirs, "rev-parse", "HEAD");
    const taken = new Date(Date.now() - 30 * 3_600_000).toISOString();
    const snap = git(theirs, "commit-tree", `${head}^{tree}`, "-p", head, "-m", "codecast wip snapshot", "-m", `codecast-branch: main\ncodecast-taken-at: ${taken}`);
    git(theirs, "push", "-q", "origin", `${snap}:refs/codecast/wip/${CONV}`);
    const s = await preparePickup(mine, conversation({ remoteUrl: null }));
    expect(s.takenAt).toBe(taken);
    expect(s.warnings.join()).toContain("snapshot is 30 hours old");
  });

  test("a ref that is not a codecast snapshot is refused", async () => {
    git(theirs, "push", "-q", "origin", `HEAD:refs/codecast/wip/${CONV}`);
    const err = await preparePickup(mine, conversation({ remoteUrl: null })).catch((e) => e);
    expect(err.message).toContain("is not a codecast snapshot");
  });
});

describe("pickupBranches", () => {
  test("names", () => {
    expect(pickupBranches({ branch: "main" }, CONV)).toEqual({ branch: "main", altBranch: "main-pickup-jx7pick" });
    expect(pickupBranches({ branch: "HEAD" }, CONV)).toEqual({ branch: "codecast/pickup-jx7pick" });
    expect(pickupBranches({ branch: "main" }, CONV, "mine")).toEqual({ branch: "mine" });
  });
});

describe("fetchPickupConversation", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const respond = (status: number, body: unknown) => {
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  };
  const auth = { convexUrl: "https://x.convex.cloud", authToken: "t" };

  test("maps the export's conversation", async () => {
    respond(200, { conversation: { id: CONV, title: "Widget", git_remote_url: REMOTE_URL, updated_at: "2026-10-06T00:00:00Z" }, messages: [] });
    expect(await fetchPickupConversation("jx7pick", auth)).toEqual({ id: CONV, title: "Widget", remoteUrl: REMOTE_URL, updatedAt: "2026-10-06T00:00:00Z" });
  });

  test("not found, no access and signed out read as reasons", async () => {
    respond(404, { error: "Conversation not found" });
    expect((await fetchPickupConversation("jx7nope", auth).catch((e) => e)).message).toBe("no session jx7nope found");
    respond(400, { error: "Access denied" });
    expect((await fetchPickupConversation("jx7priv", auth).catch((e) => e)).message).toContain("not shared with you");
    respond(401, { error: "Unauthorized" });
    expect((await fetchPickupConversation("jx7priv", auth).catch((e) => e)).message).toContain("cast auth");
  });
});
