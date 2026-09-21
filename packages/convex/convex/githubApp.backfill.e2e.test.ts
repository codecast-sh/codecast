import { afterEach, describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { internal } from "./_generated/api";
import { applyInstallationRepositoriesEvent, backfillInstallationPulls, getInstallation, stampInstallationSync } from "./githubApp";
import { listPulls } from "./githubApi";
import { syncPRFromGitHub } from "./pull_requests";
import { makeFakeDb } from "./testDb";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const repo = (id: number, name: string) => ({ id, name, full_name: `littlebirdai/${name}` });
const removed = repo(1, "ragtag");
const kept = repo(2, "littlebird");
const call = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);

function setup() {
  const db = makeFakeDb({ github_app_installations: [{
    _id: "install", installation_id: 42, team_id: "team", account_login: "littlebirdai",
    repository_selection: "selected", repositories: [removed, kept], updated_at: 1,
  }] });
  const requests: URL[] = [];
  let visible = [kept];
  let failure = 404;
  let listResponse: (() => Response) | undefined;
  let beforePull: (url: URL) => Promise<void> = async () => {};
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname === "/installation/repositories") {
      if (listResponse) return listResponse();
      const page = Number(url.searchParams.get("page"));
      return Response.json({ repositories: visible.slice((page - 1) * 100, page * 100) });
    }
    await beforePull(url);
    if (url.pathname === "/repos/littlebirdai/ragtag/pulls") return Response.json({ message: "failure" }, { status: failure });
    if (url.pathname !== "/repos/littlebirdai/littlebird/pulls") throw new Error(`Unexpected request: ${url}`);
    return Response.json(url.searchParams.get("state") === "closed" ? [{
      id: 123, number: 7, title: "Existing PR", body: "", state: "closed",
      user: { login: "ada" }, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-02T00:00:00Z",
    }] : []);
  }) as typeof fetch;
  const handlers: Record<string, any> = {
    "githubApp:getInstallation": getInstallation,
    "githubApp:stampInstallationSync": stampInstallationSync,
    "githubApi:listPulls": listPulls,
    "pull_requests:syncPRFromGitHub": syncPRFromGitHub,
  };
  const invoke = async (ref: any, args: any): Promise<any> => {
    const name = getFunctionName(ref);
    if (name === "githubApp:getInstallationToken") return { token: "test" };
    if (!handlers[name]) throw new Error(`Unexpected function: ${name}`);
    return structuredClone(await call(handlers[name], ctx, args));
  };
  const ctx = { db, runQuery: invoke, runAction: invoke, runMutation: invoke };
  const row = () => db.get("install");
  const changeAccess = () => call(applyInstallationRepositoriesEvent, ctx, {
    installation_id: 42, repository_selection: "selected", added: [kept], removed: [removed],
  });
  const run = (repositories?: string[]) => call(backfillInstallationPulls, ctx, {
    installation_id: 42, ...(repositories ? { repositories } : {}),
  });
  return {
    ctx, db, requests, row, changeAccess, run,
    setVisible: (repos: typeof visible) => { visible = repos; },
    setFailure: (status: number) => { failure = status; },
    setListResponse: (fn: () => Response) => { listResponse = fn; },
    onPull: (fn: typeof beforePull) => { beforePull = fn; },
  };
}

describe("GitHub backfill across repository access changes", () => {
  test("a removal before its webhook skips the 404 and imports the retained repository", async () => {
    const s = setup();
    expect(await s.run()).toEqual({ repositories: 1, pulls: 1 });
    expect(s.db._tables.pull_requests.map((p: any) => [p.repository, p.number, p.team_id]))
      .toEqual([[kept.full_name, 7, "team"]]);
    expect((await s.row()).last_error).toBeUndefined();
    expect((await s.row()).last_sync_at).toBeGreaterThan(0);
  });

  test("an all-repository scan follows a switch to one selected repository", async () => {
    const s = setup();
    await s.db.patch("install", { repository_selection: "all", repositories: undefined });
    s.setVisible([removed, kept]);
    s.onPull(async (url) => {
      if (!url.pathname.includes("/ragtag/")) return;
      s.setVisible([kept]);
      await s.changeAccess();
    });
    expect(await s.run()).toEqual({ repositories: 1, pulls: 1 });
    expect((await s.row()).repository_selection).toBe("selected");
    expect((await s.row()).last_error).toBeUndefined();
    expect(s.db._tables.pull_requests.map((p: any) => p.repository)).toEqual([kept.full_name]);
  });

  test("a removal between closed and open pages stops the next request", async () => {
    const s = setup();
    s.onPull(async () => {
      await call(applyInstallationRepositoriesEvent, s.ctx, {
        installation_id: 42, repository_selection: "selected", added: [], removed: [kept],
      });
    });
    await s.run([kept.full_name]);
    expect(s.requests.map((url) => url.searchParams.get("state"))).toEqual(["closed"]);
    expect((await s.row()).last_error).toBeUndefined();
  });

  test("a queued add that has since been removed never requests the removed repository", async () => {
    const s = setup();
    await s.changeAccess();
    expect(await s.run([removed.full_name])).toEqual({ repositories: 0, pulls: 0 });
    expect(s.requests).toHaveLength(0);
  });

  test("an in-flight old failure cannot replace the newer successful backfill", async () => {
    const s = setup();
    let newerSync: number;
    s.onPull(async (url) => {
      if (!url.pathname.includes("/ragtag/")) return;
      await s.changeAccess();
      await s.run([kept.full_name]);
      newerSync = (await s.row()).last_sync_at;
    });
    await s.run();
    expect((await s.row()).last_error).toBeUndefined();
    expect((await s.row()).last_sync_at).toBe(newerSync!);
  });

  test.each([undefined, "old failure"])("an outdated status write (%s) leaves the current status intact", async (error) => {
    const s = setup();
    await s.changeAccess();
    await s.ctx.runMutation(internal.githubApp.stampInstallationSync, {
      installation_id: 42, expected_updated_at: (await s.row()).updated_at, error: "current failure",
    });
    await s.ctx.runMutation(internal.githubApp.stampInstallationSync, {
      installation_id: 42, expected_updated_at: 1, ...(error ? { error } : {}),
    });
    expect((await s.row()).last_error).toBe("current failure");
  });

  test("a 404 for a repository still granted to the app remains a failure", async () => {
    const s = setup();
    s.setVisible([removed, kept]);
    await expect(s.run()).rejects.toThrow("GitHub returned 404");
    expect((await s.row()).last_error).toContain("Backfill failed:");
  });

  test.each([401, 403, 429, 500])("HTTP %s remains a failure even if repository access changed", async (status) => {
    const s = setup();
    s.setFailure(status);
    await expect(s.run()).rejects.toThrow(`GitHub API error: ${status}`);
    expect((await s.row()).last_error).toContain(String(status));
    expect(s.requests.some((url) => url.pathname === "/installation/repositories")).toBe(false);
  });

  test("absence is checked past the normal 300-repository backfill cap", async () => {
    const s = setup();
    s.setVisible([...Array.from({ length: 300 }, (_, i) => repo(i + 10, `other-${i}`)), removed]);
    await expect(s.run()).rejects.toThrow("GitHub returned 404");
    expect(s.requests.filter((url) => url.pathname === "/installation/repositories")).toHaveLength(4);
  });

  test.each([401, 500])("a failed access recheck (%s) cannot turn the 404 into success", async (status) => {
    const s = setup();
    s.setListResponse(() => new Response("unavailable", { status }));
    await expect(s.run()).rejects.toThrow("Failed to list installation repositories");
    expect((await s.row()).last_error).toContain(String(status));
  });

  test("a malformed repository list cannot prove that access was removed", async () => {
    const s = setup();
    s.setListResponse(() => Response.json({}));
    await expect(s.run()).rejects.toThrow("invalid installation repository list");
    expect((await s.row()).last_error).toContain("invalid installation repository list");
  });
});
