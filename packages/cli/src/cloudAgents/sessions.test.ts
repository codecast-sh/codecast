import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CursorCloudAdapter, CursorCloudApi } from "./cursor.js";
import { CloudApiError } from "./http.js";
import { CloudAgentSessions, githubRepoAt } from "./sessions.js";
import { CloudAgentSetupError } from "./types.js";
import { deviceLabel } from "../remote/device.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) try { fn(); } catch {} });
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sessions-"));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** The Cursor adapter with no key on the machine, or with `api` as its client. */
function adapterWith(api: CursorCloudApi | null): CursorCloudAdapter {
  const adapter = new CursorCloudAdapter({ readKey: () => null });
  if (api) adapter.client = () => api;
  return adapter;
}

function sessions(api: CursorCloudApi | null, file = path.join(tmp(), "sessions.json")) {
  const statuses: string[] = [];
  const s = new CloudAgentSessions(adapterWith(api), {
    watcher: () => ({ follow: async () => {}, setNotice: () => {} }),
    bindSession: () => {},
    agentForConversation: () => undefined,
    setStatus: (_c, st) => statuses.push(st),
    log: () => {},
  }, file);
  return { s, statuses };
}

describe("Cursor Cloud sessions: failures", () => {
  test("no key on the machine is a setup error, held with the key reason", async () => {
    const { s } = sessions(null);
    await s.start("conv1", undefined, "cloud");
    const err = await s.deliver("conv1", "hi").catch((e) => e);
    expect(err).toMatchObject({ kind: "key_missing", holdReason: `waiting for a Cursor API key on ${deviceLabel()}` });
    // The card id is the one the daemon has always posted, so a live card is not duplicated.
    expect(err.cardKey("conv1")).toBe("cursor-cloud-setup:conv1:key_missing");
  });

  test("a rejected key and an unreachable repo name the fix", async () => {
    const reject = (status: number, code: string, message: string) => ({ createAgent: async () => { throw new CloudApiError(status, code, message); } }) as unknown as CursorCloudApi;
    const a = sessions(reject(401, "error", "Invalid User API Key"));
    await a.s.start("c", undefined, "cloud");
    await expect(a.s.deliver("c", "hi")).rejects.toMatchObject({ kind: "key_invalid" });
    const b = sessions(reject(400, "validation_error", "Failed to verify existence of branch 'main' in repository codecast-sh/codecast."));
    await b.s.start("c", undefined, "cloud");
    const err = await b.s.deliver("c", "hi").catch((e) => e);
    expect(err).toBeInstanceOf(CloudAgentSetupError);
    expect(err.kind).toBe("repo");
    expect(err.holdReason).toBeUndefined();
    expect(err.message).toBe("Cursor Cloud can't reach this repository (Failed to verify existence of branch 'main' in repository codecast-sh/codecast). Give Cursor's GitHub app access to it at https://cursor.com/dashboard/integrations; the message retries on its own.");
  });

  test("a follow-up while a run is going is busy, which the delivery layer retries", async () => {
    const api = { createRun: async () => { throw new CloudApiError(409, "conflict", "run in progress"); } } as unknown as CursorCloudApi;
    const file = path.join(tmp(), "sessions.json");
    fs.writeFileSync(file, JSON.stringify({ c: { agentId: "bc-1", model: "" } }));
    const { s: fresh } = sessions(api, file);
    await expect(fresh.deliver("c", "more")).rejects.toThrow(/^AGENT_STDIN_NOT_READY: the Cursor Cloud agent is still running/);
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
