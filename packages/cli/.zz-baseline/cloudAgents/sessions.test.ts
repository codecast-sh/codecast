import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CursorCloudAdapter, CursorCloudApi } from "./cursor.js";
import { CloudApiError } from "./http.js";
import { CloudAgentSessions, githubRepoAt } from "./sessions.js";
import { CloudShapeError } from "./shape.js";
import { CloudAgentSetupError, CloudAgentUnsentError } from "./types.js";
import { fakeSessionWatcher } from "../test-helpers/cloudAgentFakes.js";
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
  const adapter = adapterWith(api);
  const s = new CloudAgentSessions(adapter, {
    watcher: () => fakeSessionWatcher(adapter),
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
    // Held with its reason (never spending retries), and asked again less often than a missing key is looked for.
    expect(err.holdReason).toBe("waiting until Cursor Cloud can reach this repository");
    expect(err.recheckMs).toBeGreaterThan(5_000);
    expect(err.message).toBe("Cursor Cloud can't reach this repository (Failed to verify existence of branch 'main' in repository codecast-sh/codecast). Give Cursor's GitHub app access to it at https://cursor.com/dashboard/integrations; the message retries on its own.");
  });

  test("a message held for a folder with no GitHub remote goes out once the folder has one", async () => {
    const created: unknown[] = [];
    const api = { createAgent: async (req: { repos?: unknown }) => { created.push(req.repos); return { agent: { id: "bc-new" } }; } } as unknown as CursorCloudApi;
    const adapter = adapterWith(api);
    const create = adapter.create.bind(adapter);
    adapter.create = async (c, session, content) => {
      if (!session.repoUrl) throw CloudAgentSetupError.repoUnreachable(adapter, session, "no GitHub remote", "Add one");
      return create(c, session, content);
    };
    const s = new CloudAgentSessions(adapter, { watcher: () => null, bindSession: () => {}, agentForConversation: () => undefined, setStatus: () => {}, log: () => {} }, path.join(tmp(), "sessions.json"));
    const dir = tmp();
    execFileSync("git", ["-C", dir, "init", "-q"]);
    await s.start("c", dir, "cloud");
    await expect(s.deliver("c", "hi")).rejects.toMatchObject({ kind: "repo" });
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:acme/app.git"]);
    expect(await s.deliver("c", "hi")).toBe(true);
    expect(created).toEqual([[{ url: "https://github.com/acme/app" }]]);
  }, 30_000);

  test("a create the provider took but answered in a shape codecast can't read is never sent again, for any provider", async () => {
    const shapeBreak = (wrote: boolean) => ({ createAgent: async () => { throw new CloudShapeError("agent.id", "a string", "a number", "POST /v0/agents", wrote); } }) as unknown as CursorCloudApi;
    const a = sessions(shapeBreak(true));
    await a.s.start("c", undefined, "cloud");
    expect(await a.s.deliver("c", "hi").catch((e) => e)).toBeInstanceOf(CloudAgentUnsentError);
    // A read before anything was sent (a list the create looks things up in) is the provider changing: held for a retry.
    const b = sessions(shapeBreak(false));
    await b.s.start("c", undefined, "cloud");
    expect(await b.s.deliver("c", "hi").catch((e) => e)).toMatchObject({ kind: "changed" });
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
  }, 30_000);

  test("unpushed commits are called out", async () => {
    const local = checkout();
    commit(local, "two");
    commit(local, "three");
    const r = await githubRepoAt(local);
    expect(r?.startingRef).toBe("main");
    expect(r?.notice).toContain("2 local commits are not pushed");
  }, 30_000);

  test("a branch GitHub doesn't have starts from the default branch, and says so", async () => {
    const local = checkout();
    git(local, "checkout", "-q", "-b", "feat");
    const r = await githubRepoAt(local);
    expect(r).toMatchObject({ repoUrl: "https://github.com/acme/app" });
    expect(r?.startingRef).toBeUndefined();
    expect(r?.notice).toContain("`feat` is not on GitHub yet");
  }, 30_000);

  test("no GitHub remote: no repo", async () => {
    const d = tmp();
    git(d, "init", "-q");
    expect(await githubRepoAt(d)).toBeNull();
  }, 30_000);
});
