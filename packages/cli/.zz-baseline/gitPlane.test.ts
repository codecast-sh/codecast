import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isRendezvousUrl,
  repoRootFor,
  resetGitPlaneState,
  sweepGitPlane,
  type GitPlaneDeps,
} from "./gitPlane.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

let dir: string;

function makeRepo(name: string): string {
  const repo = path.join(dir, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "root");
  return repo;
}

function deps(overrides: Partial<GitPlaneDeps> = {}): GitPlaneDeps & { usable: string[] } {
  const usable: string[] = [];
  return {
    usable,
    resolveCanonical: async () => undefined,
    onRemoteUsable: (root) => usable.push(root),
    log: () => {},
    ...overrides,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitplane-"));
  resetGitPlaneState();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("isRendezvousUrl", () => {
  test("accepts real remote URLs, rejects transport leftovers", () => {
    expect(isRendezvousUrl("git@github.com:org/repo.git")).toBe(true);
    expect(isRendezvousUrl("https://github.com/org/repo.git")).toBe(true);
    expect(isRendezvousUrl("ssh://git@host/repo.git")).toBe(true);
    // The m1 poison: a bundle file path, alive or dead, is never a rendezvous.
    expect(isRendezvousUrl("/tmp/codecast-bundle-123.bundle")).toBe(false);
    expect(isRendezvousUrl("file:///tmp/x.bundle")).toBe(false);
    expect(isRendezvousUrl("../elsewhere/repo")).toBe(false);
    expect(isRendezvousUrl(undefined)).toBe(false);
    expect(isRendezvousUrl("")).toBe(false);
  });
});

describe("sweepGitPlane repair", () => {
  test("repairs a dead-bundle origin from the conversation's recorded URL", async () => {
    const repo = makeRepo("poisoned");
    git(repo, "remote", "add", "origin", "/tmp/codecast-bundle-999.bundle");
    const d = deps({ resolveCanonical: async () => "https://example.com/org/repo.git" });

    const [state] = await sweepGitPlane([{ root: repo, conversationIds: ["c1"] }], d, 0);

    expect(git(repo, "remote", "get-url", "origin")).toBe("https://example.com/org/repo.git");
    expect(state.repaired_from).toBe("/tmp/codecast-bundle-999.bundle");
    expect(state.origin_ok).toBe(true);
    // The resurrect signal fired so retired wip pushes come back.
    expect(d.usable).toEqual([repo]);
  });

  test("adds origin to a repo that has none when a conversation knows the URL", async () => {
    const repo = makeRepo("orphan");
    const d = deps({ resolveCanonical: async () => "git@example.com:org/repo.git" });

    const [state] = await sweepGitPlane([{ root: repo, conversationIds: ["c1"] }], d, 0);

    expect(git(repo, "remote", "get-url", "origin")).toBe("git@example.com:org/repo.git");
    expect(state.repaired_from).toBe("(none)");
  });

  test("tries conversations until one knows a usable URL", async () => {
    const repo = makeRepo("multi");
    git(repo, "remote", "add", "origin", "file:///tmp/dead.bundle");
    const answers: Record<string, string | undefined> = {
      c1: undefined,
      c2: "/local/path/not/usable",
      c3: "https://example.com/real.git",
    };
    const d = deps({ resolveCanonical: async (id) => answers[id] });

    const [state] = await sweepGitPlane([{ root: repo, conversationIds: ["c1", "c2", "c3"] }], d, 0);

    expect(git(repo, "remote", "get-url", "origin")).toBe("https://example.com/real.git");
    expect(state.origin_ok).toBe(true);
  });

  test("leaves a real origin alone even when conversations name a different form", async () => {
    const repo = makeRepo("healthy");
    git(repo, "remote", "add", "origin", "git@github.com:org/repo.git");
    const d = deps({ resolveCanonical: async () => "https://github.com/org/repo.git" });

    const [state] = await sweepGitPlane([{ root: repo, conversationIds: ["c1"] }], d, 0);

    // A machine may hold its own credential-appropriate form (SSH vs HTTPS).
    expect(git(repo, "remote", "get-url", "origin")).toBe("git@github.com:org/repo.git");
    expect(state.repaired_from).toBeUndefined();
    expect(state.origin_ok).toBe(true);
  });

  test("reports origin_ok=false when nothing knows a usable URL, and never throws", async () => {
    const repo = makeRepo("stuck");
    git(repo, "remote", "add", "origin", "/tmp/gone.bundle");
    const d = deps();

    const [state] = await sweepGitPlane([{ root: repo, conversationIds: ["c1"] }], d, 0);

    expect(state.origin_ok).toBe(false);
    expect(git(repo, "remote", "get-url", "origin")).toBe("/tmp/gone.bundle");
    expect(d.usable).toEqual([]);
  });
});

describe("sweepGitPlane measurement", () => {
  test("captures a failing fetch honestly and still measures ahead/behind", async () => {
    const repo = makeRepo("measured");
    // A rendezvous-shaped URL that cannot resolve: fetch fails, state records it.
    git(repo, "remote", "add", "origin", "https://invalid.invalid/org/repo.git");
    // Hand-build the remote-tracking state a real fetch would have created:
    // origin/main two commits back, HEAD one ahead of a shared base.
    const base = git(repo, "rev-parse", "HEAD");
    git(repo, "update-ref", "refs/remotes/origin/main", base);
    git(repo, "config", "branch.main.remote", "origin");
    git(repo, "config", "branch.main.merge", "refs/heads/main");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "local work");

    const [state] = await sweepGitPlane([{ root: repo, conversationIds: ["c1"] }], deps(), Date.now());

    expect(state.origin_ok).toBe(true);
    expect(state.fetch_ok).toBe(false);
    expect(state.error).toBeTruthy();
    expect(state.branch).toBe("main");
    expect(state.ahead).toBe(1);
    expect(state.behind).toBe(0);
  });

  test("fires the recovery signal when a failing fetch starts succeeding", async () => {
    const repo = makeRepo("recovering");
    // First pass: unreachable origin -> fetch fails.
    git(repo, "remote", "add", "origin", "https://invalid.invalid/org/repo.git");
    const d = deps();
    await sweepGitPlane([{ root: repo, conversationIds: ["c1"] }], d, Date.now());
    expect(d.usable).toEqual([]);

    // Origin becomes fetchable (fixed out of band). ext:: URLs pass the
    // rendezvous check while resolving to a local command, so the fetch is real.
    const upstream = makeRepo("upstream.git");
    git(repo, "remote", "set-url", "origin", `ext::git --namespace=x %s ${upstream}`);
    git(repo, "config", "protocol.ext.allow", "always");
    const later = Date.now() + 11 * 60_000; // past the fetch cadence gate
    const [state] = await sweepGitPlane([{ root: repo, conversationIds: ["c1"] }], d, later);

    expect(state.fetch_ok).toBe(true);
    expect(d.usable).toEqual([repo]);
  });
});

describe("sweepGitPlane access grants", () => {
  // An ext:: origin whose command prints an auth refusal: rendezvous-shaped
  // (passes isRendezvousUrl), but every fetch fails like a denied remote.
  // A script FILE, not inline `sh -c`: the ext transport splits its command on
  // whitespace, so inline quoting mangles into a shell syntax error whose
  // stderr (git's generic "access rights" hint) is deliberately NOT classified
  // as an auth failure.
  function denyOrigin(repo: string): void {
    const script = path.join(repo, "deny.sh");
    fs.writeFileSync(script, '#!/bin/sh\necho "ERROR: Repository not found." >&2\nexit 1\n', { mode: 0o755 });
    git(repo, "remote", "add", "origin", `ext::${script}`);
    git(repo, "config", "protocol.ext.allow", "always");
  }

  test("an auth-refused fetch mints the device key and reports needs_access", async () => {
    const repo = makeRepo("denied");
    denyOrigin(repo);
    let minted = 0;
    const d = deps({ mintDeviceKey: async () => { minted++; return "ssh-ed25519 AAAA test"; } });

    const [state] = await sweepGitPlane([{ root: repo, conversationIds: ["c1"] }], d, Date.now());

    expect(state.fetch_ok).toBe(false);
    expect(state.needs_access).toBe(true);
    expect(minted).toBe(1);
    // Not usable — the resurrect signal must NOT fire on a denied repo.
    expect(d.usable).toEqual([]);
  });

  test("needs_access persists through cadence-skipped passes", async () => {
    const repo = makeRepo("denied-sticky");
    denyOrigin(repo);
    const d = deps({ mintDeviceKey: async () => "ssh-ed25519 AAAA test" });
    const now = Date.now();
    await sweepGitPlane([{ root: repo, conversationIds: ["c1"] }], d, now);
    // Second pass inside the fetch interval: no fetch happens, flag must survive.
    const [state] = await sweepGitPlane([{ root: repo, conversationIds: ["c1"] }], d, now + 60_000);
    expect(state.fetch_ok).toBe(false);
    expect(state.needs_access).toBe(true);
  });

  test("a network failure does not mint a key or claim needs_access", async () => {
    const repo = makeRepo("net-down");
    git(repo, "remote", "add", "origin", "https://invalid.invalid/org/repo.git");
    let minted = 0;
    const d = deps({ mintDeviceKey: async () => { minted++; return "ssh-ed25519 AAAA test"; } });

    const [state] = await sweepGitPlane([{ root: repo, conversationIds: ["c1"] }], d, Date.now());

    expect(state.fetch_ok).toBe(false);
    expect(state.needs_access).toBeUndefined();
    expect(minted).toBe(0);
  });
});

describe("repoRootFor", () => {
  test("resolves subdirectories to the toplevel and caches non-repos as null", async () => {
    const repo = makeRepo("rooted");
    const sub = path.join(repo, "packages", "x");
    fs.mkdirSync(sub, { recursive: true });
    expect(await repoRootFor(sub)).toBe(fs.realpathSync(repo));
    const plain = path.join(dir, "not-a-repo");
    fs.mkdirSync(plain);
    expect(await repoRootFor(plain)).toBeNull();
  });
});
