import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CursorCloudApi, CursorCloudApiError } from "./cursorCloud.js";
import { CursorCloudSessions, CursorCloudSetupError, githubRepoAt } from "./cursorCloudSessions.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) try { fn(); } catch {} });
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sessions-"));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function sessions(api: CursorCloudApi | null) {
  const statuses: string[] = [];
  const watcher = api ? { api: () => api, follow: async () => {}, setNotice: () => {} } : null;
  const s = new CursorCloudSessions({
    watcher: () => watcher as any,
    bindSession: () => {},
    agentForConversation: () => undefined,
    setStatus: (_c, st) => statuses.push(st),
    log: () => {},
  }, path.join(tmp(), "sessions.json"));
  return { s, statuses };
}

describe("CursorCloudSessions failures", () => {
  test("no key on the machine is a setup error, not a retry", async () => {
    const { s } = sessions(null);
    await s.start("conv1", undefined, "cloud");
    await expect(s.deliver("conv1", "hi")).rejects.toMatchObject({ kind: "key_missing" });
  });

  test("a rejected key and an unreachable repo name the fix", async () => {
    const reject = (status: number, code: string, message: string) => ({ createAgent: async () => { throw new CursorCloudApiError(status, code, message); } }) as unknown as CursorCloudApi;
    const a = sessions(reject(401, "error", "Invalid User API Key"));
    await a.s.start("c", undefined, "cloud");
    await expect(a.s.deliver("c", "hi")).rejects.toMatchObject({ kind: "key_invalid" });
    const b = sessions(reject(400, "validation_error", "Failed to verify existence of branch 'main' in repository codecast-sh/codecast."));
    await b.s.start("c", undefined, "cloud");
    const err = await b.s.deliver("c", "hi").catch((e) => e);
    expect(err).toBeInstanceOf(CursorCloudSetupError);
    expect(err.kind).toBe("repo");
    expect(err.message).toContain("GitHub app");
  });
});

describe("githubRepoAt", () => {
  const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" }).toString().trim();
  const commit = (dir: string, msg: string) => git(dir, "-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", msg);
  // origin reads as GitHub; insteadOf routes it to a local bare repo.
  function checkout(): string {
    const bare = tmp(), local = tmp();
    git(bare, "init", "-q", "--bare", "-b", "main");
    git(local, "init", "-q", "-b", "main");
    git(local, "config", `url.${bare}.insteadOf`, "git@github.com:acme/app.git");
    git(local, "remote", "add", "origin", "git@github.com:acme/app.git");
    commit(local, "one");
    git(local, "push", "-q", "origin", "main");
    return local;
  }

  test("a pushed, up to date branch starts from itself with no notice", async () => {
    expect(await githubRepoAt(checkout())).toEqual({ repoUrl: "https://github.com/acme/app", startingRef: "main" });
  });

  test("unpushed commits are called out", async () => {
    const local = checkout();
    commit(local, "two");
    commit(local, "three");
    const r = await githubRepoAt(local);
    expect(r?.startingRef).toBe("main");
    expect(r?.notice).toContain("2 local commits are not pushed");
  });

  test("a branch GitHub doesn't have starts from the default branch, and says so", async () => {
    const local = checkout();
    git(local, "checkout", "-q", "-b", "feat");
    const r = await githubRepoAt(local);
    expect(r).toMatchObject({ repoUrl: "https://github.com/acme/app" });
    expect(r?.startingRef).toBeUndefined();
    expect(r?.notice).toContain("`feat` is not on GitHub yet");
  });

  test("no GitHub remote: no repo", async () => {
    const d = tmp();
    git(d, "init", "-q");
    expect(await githubRepoAt(d)).toBeNull();
  });
});
