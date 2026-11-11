import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import {
  exportFolder,
  isSecretFile,
  refusedFolder,
  localFolderFor,
  packFolder,
  planFolderExport,
  syncFolderFromPeer,
  unpackFolder,
  unpackFolderStream,
  type ExportFolderResult,
  type PeerAttempt,
  type PeerOutcome,
  type PeerRequestOpts,
} from "./folderSync";
import type { TailnetStatus } from "./cloud/tailnet";
import { closeAllGrants, liveGrantCount, type GrantOutcome } from "./peer/grant";
import { pollUntil } from "./test-helpers/pollUntil";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "folder-sync-test-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function write(rel: string, body = "x") {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk("");
  return out.sort();
}

describe("localFolderFor", () => {
  test("maps another user's home onto this one", () => {
    expect(localFolderFor("/Users/m1/src/family", "/Users/ashot")).toBe("/Users/ashot/src/family");
    expect(localFolderFor("/home/dev/work/x", "/Users/ashot")).toBe("/Users/ashot/work/x");
  });
  test("leaves paths outside a home alone", () => {
    expect(localFolderFor("/opt/data/x", "/Users/ashot")).toBe("/opt/data/x");
  });
});

describe("planFolderExport", () => {
  test("a plain folder skips caches and .env files", async () => {
    const dir = path.join(root, "family");
    write("family/notes.md");
    write("family/scripts/import.sh");
    write("family/.env", "SECRET=1");
    write("family/.env.local", "SECRET=1");
    write("family/node_modules/pkg/index.js");
    write("family/.venv/bin/python");
    const plan = await planFolderExport(dir);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.entries.sort()).toEqual(["notes.md", "scripts/import.sh"]);
  });

  test("a missing folder says so", async () => {
    const plan = await planFolderExport(path.join(root, "nope"));
    expect(plan).toMatchObject({ ok: false, missing: true });
  });

  test("a folder past the cap is refused before packing", async () => {
    write("big/a.bin", "x".repeat(2048));
    const plan = await planFolderExport(path.join(root, "big"), 1024);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("too large");
  });
});

describe("pack and unpack", () => {
  test("a git checkout travels with .git and without gitignored files", async () => {
    const src = path.join(root, "repo");
    write("repo/a.txt", "tracked");
    write("repo/.gitignore", ".env\nbuild/\n");
    write("repo/.env", "SECRET=1");
    write("repo/build/out.js");
    execFileSync("git", ["init", "-q", src]);
    execFileSync("git", ["-C", src, "add", "a.txt", ".gitignore"]);
    execFileSync("git", ["-C", src, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
    write("repo/untracked.txt", "new work");
    const plan = await planFolderExport(src);
    if (!plan.ok) throw new Error(plan.reason);
    const dest = path.join(root, "elsewhere", "repo");
    await unpackFolder(await packFolder(plan), dest);
    const files = listTree(dest).filter((f) => !f.startsWith(".git/"));
    expect(files).toEqual([".gitignore", "a.txt", "untracked.txt"]);
    expect(execFileSync("git", ["-C", dest, "log", "--format=%s"], { encoding: "utf-8" }).trim()).toBe("init");
    expect(execFileSync("git", ["-C", dest, "status", "--porcelain"], { encoding: "utf-8" }).trim()).toBe("?? untracked.txt");
    expect(fs.readdirSync(path.dirname(dest))).toEqual(["repo"]);
  });

  test("unpack never replaces a folder that appeared meanwhile", async () => {
    write("src/a.txt", "theirs");
    const plan = await planFolderExport(path.join(root, "src"));
    if (!plan.ok) throw new Error(plan.reason);
    write("dest/mine.txt", "mine");
    await unpackFolder(await packFolder(plan), path.join(root, "dest"));
    expect(listTree(path.join(root, "dest"))).toEqual(["mine.txt"]);
  });
});

describe("refusedFolder", () => {
  test("only ordinary folders inside home", () => {
    expect(refusedFolder("/Users/a/src/family", "/Users/a")).toBeNull();
    expect(refusedFolder("/Users/a", "/Users/a")).not.toBeNull();
    expect(refusedFolder("/Users/a/.ssh", "/Users/a")).not.toBeNull();
    expect(refusedFolder("/Users/a/.config/gh", "/Users/a")).not.toBeNull();
    expect(refusedFolder("/Users/a/Library/LaunchAgents", "/Users/a")).not.toBeNull();
    expect(refusedFolder("/etc", "/Users/a")).not.toBeNull();
    expect(refusedFolder("/Users/b/src", "/Users/a")).not.toBeNull();
  });
});

describe("isSecretFile", () => {
  test("keys and credentials", () => {
    for (const n of [".env", ".env.local", "id_ed25519", "id_rsa.pub", "server.pem", "tls.key", "cert.p12", ".netrc", ".npmrc", "credentials.json"]) expect(isSecretFile(n)).toBe(true);
    for (const n of ["notes.md", "keyboard.ts", "identity.ts", "env.ts"]) expect(isSecretFile(n)).toBe(false);
  });
});

describe("exportFolder", () => {
  test("refuses a private folder in home", async () => {
    write(".ssh/id_ed25519", "k");
    const out = await exportFolder({ path: path.join(root, ".ssh") }, { home: root, upload: async () => "s" });
    expect(out.ok).toBe(false);
  });

  test("refuses a home folder", async () => {
    const out = await exportFolder({ path: root }, { home: root, upload: async () => "s" });
    expect(out.ok).toBe(false);
  });

  test("answers missing when the folder is not here", async () => {
    const out = await exportFolder({ path: path.join(root, "gone") }, { home: root, upload: async () => "s" });
    expect(out).toMatchObject({ ok: false, missing: true });
  });
});

describe("syncFolderFromPeer", () => {
  async function exported(dir: string, store: Map<string, Uint8Array>) {
    return exportFolder({ path: dir }, {
      home: root,
      upload: async (b) => { store.set("s1", b); return "s1"; },
    });
  }

  test("takes the folder from the machine that has it and discards every archive", async () => {
    write("family/notes.md", "hello");
    const store = new Map<string, Uint8Array>();
    const sent = await exported(path.join(root, "family"), store);
    const rows: PeerOutcome[] = [
      { command_id: "c1", executed_at: 1, result: JSON.stringify({ ok: false, missing: true, reason: "not here" }), error: null, label: "Mac mini" },
      { command_id: "c2", executed_at: 1, result: JSON.stringify(sent), error: null, label: "MacBook-Pro-182" },
    ];
    const discarded: string[] = [];
    const dest = path.join(root, "here", "family");
    const r = await syncFolderFromPeer(dest, {
      request: async () => ({ command_ids: ["c1", "c2"], labels: {} }),
      outcomes: async () => rows,
      download: async (id) => store.get(id) ?? null,
      discard: async (id) => { discarded.push(id); },
      sleep: async () => {},
    });
    expect(r).toMatchObject({ ok: true, from: "MacBook-Pro-182", files: 1 });
    expect(fs.readFileSync(path.join(dest, "notes.md"), "utf-8")).toBe("hello");
    expect(discarded.sort()).toEqual(["c1", "c2"]);
  });

  test("nobody has it", async () => {
    const r = await syncFolderFromPeer(path.join(root, "x"), {
      request: async () => ({ command_ids: ["c1"], labels: { c1: "Mac mini" } }),
      outcomes: async () => [{ command_id: "c1", executed_at: 1, result: JSON.stringify({ ok: false, missing: true, reason: "" }), error: null, label: "Mac mini" }],
      download: async () => null,
      discard: async () => {},
      sleep: async () => {},
    });
    expect(r).toEqual({ ok: false, reason: "none of your other machines has it" });
  });

  test("no other machine online", async () => {
    const r = await syncFolderFromPeer(path.join(root, "x"), {
      request: async () => ({ command_ids: [], labels: {} }),
      outcomes: async () => [],
      download: async () => null,
      discard: async () => {},
    });
    expect(r).toEqual({ ok: false, reason: "none of your other machines is online to send it" });
  });

  test("an old daemon's Unknown command and a timeout are named", async () => {
    let t = 0;
    const r = await syncFolderFromPeer(path.join(root, "x"), {
      request: async () => ({ command_ids: ["c1", "c2"], labels: { c1: "Old Mac", c2: "Slow Mac" } }),
      outcomes: async () => [{ command_id: "c1", executed_at: 1, result: null, error: "Unknown command", label: "Old Mac" }],
      download: async () => null,
      discard: async () => {},
      sleep: async () => { t += 2_000; },
      now: () => t,
    }, 5_000);
    expect(r).toEqual({ ok: false, reason: "Old Mac: Unknown command" });
  });
});

describe("hardened extraction", () => {
  function tarOf(dir: string): Uint8Array {
    return new Uint8Array(execFileSync("tar", ["-czf", "-", "-C", dir, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } }));
  }

  test("escaping symlinks, special files, hooks and program-running git config do not survive", async () => {
    const src = path.join(root, "evil");
    write("evil/a.txt", "ok");
    write("evil/sub/b.txt", "ok");
    fs.symlinkSync("a.txt", path.join(src, "inside"));
    fs.symlinkSync("../a.txt", path.join(src, "sub", "up-inside"));
    fs.symlinkSync("../../..", path.join(src, "climb"));
    fs.symlinkSync("/etc/passwd", path.join(src, "abs"));
    fs.symlinkSync(".", path.join(src, "dot"));
    fs.symlinkSync("dot/..", path.join(src, "via-dot"));
    execFileSync("mkfifo", [path.join(src, "pipe")]);
    write("evil/.git/hooks/post-checkout", "#!/bin/sh\ntouch /tmp/pwned\n");
    write("evil/.git/HEAD", "ref: refs/heads/main\n");
    write("evil/.git/config", [
      "[core]", "\tbare = false", "\tfsmonitor = /tmp/x", "\thooksPath = /tmp/hooks", "\tsshCommand = evil",
      "[credential]", "\thelper = !evil", "[include]", "\tpath = /tmp/inc",
      '[includeIf "gitdir:/x/"]', "\tpath = /tmp/inc2", '[filter "lfs"]', "\tsmudge = evil",
      "[user]", "\tname = Kept", "",
    ].join("\n"));
    const dest = path.join(root, "out", "evil");
    await unpackFolder(tarOf(src), dest);
    const names = fs.readdirSync(dest).sort();
    expect(names).toEqual([".git", "a.txt", "dot", "inside", "sub"]);
    expect(fs.readFileSync(path.join(dest, "inside"), "utf-8")).toBe("ok");
    expect(fs.readFileSync(path.join(dest, "sub", "up-inside"), "utf-8")).toBe("ok");
    expect(fs.readdirSync(path.join(dest, ".git", "hooks"))).toEqual([]);
    const keys = execFileSync("git", ["config", "--file", path.join(dest, ".git", "config"), "--list", "--name-only"], { encoding: "utf-8" }).trim().split("\n").sort();
    expect(keys).toEqual(["core.bare", "user.name"]);
  });

  test("a symlinked hooks folder or .git is replaced", async () => {
    const src = path.join(root, "evil2");
    write("evil2/scripts/post-checkout", "#!/bin/sh\n");
    write("evil2/.git/HEAD", "ref: refs/heads/main\n");
    fs.symlinkSync("../scripts", path.join(src, ".git", "hooks"));
    write("evil2/nested/real/HEAD", "x");
    fs.symlinkSync("real", path.join(src, "nested", ".git"));
    const dest = path.join(root, "out", "evil2");
    await unpackFolder(tarOf(src), dest);
    expect(fs.lstatSync(path.join(dest, ".git", "hooks")).isDirectory()).toBe(true);
    expect(fs.readdirSync(path.join(dest, ".git", "hooks"))).toEqual([]);
    expect(fs.existsSync(path.join(dest, "nested", ".git"))).toBe(false);
  });

  const gitKey = (dir: string, key: string) => {
    try { return execFileSync("git", ["-C", dir, "config", key], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
  };
  const bareRepo = (rel: string, config: string) => {
    write(`${rel}/HEAD`, "ref: refs/heads/main\n");
    fs.mkdirSync(path.join(root, rel, "objects"), { recursive: true });
    fs.mkdirSync(path.join(root, rel, "refs", "heads"), { recursive: true });
    write(`${rel}/config`, config);
    write(`${rel}/hooks/post-checkout`, "#!/bin/sh\ntouch /tmp/pwned\n");
  };
  const EVIL = "[core]\n\tfsmonitor = /tmp/evil\n";

  test("git dirs are found by shape and pointers, not by name", async () => {
    execFileSync("git", ["init", "-q", path.join(root, "wt")]);
    execFileSync("git", ["-C", path.join(root, "wt"), "config", "extensions.worktreeConfig", "true"]);
    write("wt/.git/config.worktree", EVIL);
    write("gf/.git", "gitdir: notgit\n");
    bareRepo("gf/notgit", EVIL);
    execFileSync("git", ["init", "-q", path.join(root, "cd")]);
    write("cd/.git/commondir", "../other\n");
    write("cd/other/config", EVIL);
    bareRepo("bare/inner.git", EVIL);
    write("out1/.git", "gitdir: /tmp\n");
    execFileSync("git", ["init", "-q", path.join(root, "out2")]);
    write("out2/.git/commondir", "../../..\n");
    for (const repo of ["wt", "gf", "bare/inner.git"]) expect(gitKey(path.join(root, repo), "core.fsmonitor")).toBe("/tmp/evil");
    const carried: Record<string, string> = {};
    for (const name of ["wt", "gf", "cd", "bare", "out1", "out2"]) {
      carried[name] = path.join(root, "dest", name);
      await unpackFolder(tarOf(path.join(root, name)), carried[name]);
    }
    expect(gitKey(carried.wt, "core.fsmonitor")).toBeNull();
    expect(gitKey(carried.wt, "extensions.worktreeConfig")).toBeNull();
    expect(gitKey(carried.gf, "core.fsmonitor")).toBeNull();
    expect(fs.readdirSync(path.join(carried.gf, "notgit", "hooks"))).toEqual([]);
    expect(gitKey(path.join(carried.cd, "other"), "core.fsmonitor")).toBeNull();
    expect(execFileSync("git", ["config", "--file", path.join(carried.cd, "other", "config"), "--list"], { encoding: "utf-8" }).trim()).toBe("");
    expect(gitKey(path.join(carried.bare, "inner.git"), "core.fsmonitor")).toBeNull();
    expect(fs.readdirSync(path.join(carried.bare, "inner.git", "hooks"))).toEqual([]);
    expect(fs.existsSync(path.join(carried.out1, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(carried.out2, ".git", "commondir"))).toBe(false);
  });

  test("branches named hooks or config survive", async () => {
    const src = path.join(root, "repo");
    write("repo/a.txt", "x");
    execFileSync("git", ["init", "-q", "-b", "main", src]);
    execFileSync("git", ["-C", src, "add", "a.txt"]);
    execFileSync("git", ["-C", src, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
    for (const b of ["hooks", "config", "x/hooks"]) execFileSync("git", ["-C", src, "branch", b]);
    const dest = path.join(root, "out", "repo");
    await unpackFolder(tarOf(src), dest);
    const branches = execFileSync("git", ["-C", dest, "branch", "--format=%(refname:short)"], { encoding: "utf-8" }).trim().split("\n").sort();
    expect(branches).toEqual(["config", "hooks", "main", "x/hooks"]);
  });

  test("only git config keys known to run nothing survive", async () => {
    write("k/a.txt", "x");
    write("k/.git/HEAD", "ref: refs/heads/main\n");
    write("k/.git/config", [
      "[core]", "\tbare = false", "\talternateRefsCommand = evil", "\tworktree = ../../..",
      "[pager]", "\tstatus = /tmp/evil", "[alias]", "\tst = !evil", "[interactive]", "\tdiffFilter = evil",
      '[remote "origin"]', "\turl = git@example.com:a/b.git", "\tuploadpack = evil", "\treceivepack = evil",
      '[difftool "x"]', "\tcmd = evil", '[submodule "s"]', "\turl = ../s", "\tupdate = !evil",
      "[web]", "\tbrowser = evil", '[branch "main"]', "\tremote = origin", "",
    ].join("\n"));
    const dest = path.join(root, "out", "k");
    await unpackFolder(tarOf(path.join(root, "k")), dest);
    const keys = execFileSync("git", ["config", "--file", path.join(dest, ".git", "config"), "--list", "--name-only"], { encoding: "utf-8" }).trim().split("\n").sort();
    expect(keys).toEqual(["branch.main.remote", "core.bare", "remote.origin.url", "submodule.s.url"]);
  });

  test("an archive that unpacks past the cap rejects and leaves nothing behind", async () => {
    write("bomb/zeros.bin", "\0".repeat(4 * 1024 * 1024));
    const bytes = tarOf(path.join(root, "bomb"));
    expect(bytes.length).toBeLessThan(64 * 1024);
    const parent = path.join(root, "out");
    await expect(unpackFolderStream(Readable.from([Buffer.from(bytes)]), path.join(parent, "bomb"), { maxUnpackedBytes: 1024 * 1024 }))
      .rejects.toThrow(/unpacks to over/);
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  test("a truncated archive rejects and leaves nothing behind", async () => {
    write("big/a.bin", Array.from({ length: 4000 }, (_, i) => `line ${i} ${Math.random()}`).join("\n"));
    const bytes = tarOf(path.join(root, "big"));
    const parent = path.join(root, "out");
    await expect(unpackFolder(bytes.subarray(0, Math.floor(bytes.length / 2)), path.join(parent, "big"))).rejects.toThrow();
    expect(fs.readdirSync(parent)).toEqual([]);
  });
});

describe("direct links", () => {
  const SRC = { ip: "127.0.0.1", name: "source.tail1234.ts.net." };
  const DST = { ip: "127.0.0.1", name: "dest.tail1234.ts.net." };
  const node = (n: { ip: string; name: string }, extra: Record<string, unknown> = {}) => ({ DNSName: n.name, TailscaleIPs: [n.ip], Online: true, UserID: 7, ...extra });
  const seenBy = (self: typeof SRC, peer: typeof SRC, extra: Record<string, unknown> = {}): TailnetStatus =>
    ({ BackendState: "Running", Self: node(self), Peer: { k: node(peer, extra) } });

  afterEach(async () => {
    closeAllGrants();
    await pollUntil(() => liveGrantCount() === 0, "grants closed");
  });

  /** Convex and the source daemon in one: each request runs export_folder at once. */
  function fleet(dir: string, opts: { sourceStatus?: TailnetStatus; destStatus?: TailnetStatus; firewall?: boolean } = {}) {
    const rows: PeerOutcome[] = [];
    const requests: PeerRequestOpts[] = [];
    const store = new Map<string, Uint8Array>();
    const grants: GrantOutcome[] = [];
    const attempts: PeerAttempt[] = [];
    const phases: string[] = [];
    const deps = {
      direct: async () => ({ self: DST }),
      tailnetStatus: async () => opts.destStatus ?? seenBy(DST, SRC),
      request: async (o: PeerRequestOpts = {}) => {
        requests.push(o);
        const id = `c${rows.length + 1}`;
        const out = await exportFolder(
          { path: dir, relay_only: o.relay_only, direct: o.tailnet ? { requester: o.tailnet, token_hash: o.token_hash } : undefined },
          {
            home: root,
            upload: async (b) => { store.set(id, b); return id; },
            tailnetStatus: async () => opts.sourceStatus ?? seenBy(SRC, DST),
            firewallBlocks: async () => opts.firewall ?? false,
            onGrantDone: (g) => grants.push(g),
          },
        );
        rows.push({ command_id: id, executed_at: 1, result: JSON.stringify(out), error: null, label: "Mac mini", device_id: "mini" });
        return { command_ids: [id], labels: { [id]: "Mac mini" } };
      },
      outcomes: async () => rows,
      download: async (id: string) => store.get(id) ?? null,
      discard: async () => {},
      sleep: async () => {},
      onAttempt: (a: PeerAttempt) => attempts.push(a),
      onProgress: (p: { phase: string }) => phases.push(p.phase),
    };
    return { deps, rows, requests, grants, attempts, phases, results: () => rows.map((r) => JSON.parse(r.result!) as ExportFolderResult) };
  }

  test("a git checkout travels end to end over a real grant", async () => {
    const src = path.join(root, "repo");
    write("repo/a.txt", "tracked");
    write("repo/.env", "SECRET=1");
    execFileSync("git", ["init", "-q", src]);
    execFileSync("git", ["-C", src, "add", "a.txt"]);
    execFileSync("git", ["-C", src, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
    write("repo/untracked.txt", "new work");
    const f = fleet(src);
    const dest = path.join(root, "elsewhere", "repo");
    const r = await syncFolderFromPeer(dest, f.deps);
    expect(r).toMatchObject({ ok: true, mode: "direct", from: "Mac mini", files: 2 });
    expect(f.results()[0]).toMatchObject({ ok: true, direct: { ip: SRC.ip, name: SRC.name } });
    expect(f.requests[0].tailnet).toEqual(DST);
    expect(f.requests[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(listTree(dest).filter((x) => !x.startsWith(".git/"))).toEqual(["a.txt", "untracked.txt"]);
    expect(execFileSync("git", ["-C", dest, "log", "--format=%s"], { encoding: "utf-8" }).trim()).toBe("init");
    expect(f.attempts).toEqual([expect.objectContaining({ device: "Mac mini", mode: "direct", ok: true })]);
    expect(f.phases[0]).toBe("asking");
    expect(f.phases).toContain("receiving");
    await pollUntil(() => f.grants.length === 1, "grant done");
    expect(f.grants[0]).toMatchObject({ served: true });
  }, 30_000);

  test("the requester refusing the source falls back to the relay from the same machine", async () => {
    write("family/notes.md", "hello");
    const f = fleet(path.join(root, "family"), { destStatus: seenBy(DST, SRC, { UserID: 99 }) });
    const dest = path.join(root, "here", "family");
    const r = await syncFolderFromPeer(dest, f.deps);
    expect(r).toMatchObject({ ok: true, mode: "relay", from: "Mac mini" });
    expect(fs.readFileSync(path.join(dest, "notes.md"), "utf-8")).toBe("hello");
    expect(f.requests[1]).toEqual({ relay_only: true, only_device_id: "mini" });
    expect(f.attempts.map((a) => [a.mode, a.ok])).toEqual([["direct", false], ["relay", true]]);
    expect(f.attempts[0].reason).toStartWith("other_user");
  });

  test("the source skips the grant when it cannot be trusted or reached, and answers through the relay at once", async () => {
    write("family/notes.md", "hello");
    const cases: [Parameters<typeof fleet>[1], string][] = [
      [{ firewall: true }, "firewall"],
      [{ sourceStatus: seenBy(SRC, DST, { ShareeNode: true }) }, "shared_node"],
      [{ sourceStatus: { ...seenBy(SRC, DST), Self: { ...node(SRC), TailscaleIPs: ["100.99.99.99"] } } }, "userspace"],
    ];
    for (const [opts, why] of cases) {
      const f = fleet(path.join(root, "family"), opts);
      const dest = path.join(root, `here-${why}`, "family");
      const r = await syncFolderFromPeer(dest, f.deps);
      expect(r).toMatchObject({ ok: true, mode: "relay" });
      expect(f.requests).toHaveLength(1);
      expect((f.results()[0] as { direct_skipped?: string }).direct_skipped).toStartWith(why);
    }
  });

  test("a Convex that refuses the new request fields still gets the folder through the relay", async () => {
    write("family/notes.md", "hello");
    const f = fleet(path.join(root, "family"));
    const sent: PeerRequestOpts[] = [];
    const dest = path.join(root, "here", "family");
    const r = await syncFolderFromPeer(dest, {
      ...f.deps,
      request: async (o: PeerRequestOpts = {}) => {
        sent.push(o);
        if (Object.keys(o).length) throw new Error("ArgumentValidationError: Object contains extra field `tailnet`");
        return f.deps.request(o);
      },
    });
    expect(r).toMatchObject({ ok: true, mode: "relay" });
    expect(fs.readFileSync(path.join(dest, "notes.md"), "utf-8")).toBe("hello");
    expect(sent.map((o) => Object.keys(o).length > 0)).toEqual([true, false]);
    expect(liveGrantCount()).toBe(0);
  });

  test("a Convex that refuses relay_only still gets a relay answer after a failed direct link", async () => {
    write("family/notes.md", "hello");
    const f = fleet(path.join(root, "family"), { destStatus: seenBy(DST, SRC, { UserID: 99 }) });
    const dest = path.join(root, "here", "family");
    const r = await syncFolderFromPeer(dest, {
      ...f.deps,
      request: async (o: PeerRequestOpts = {}) => {
        if (o.relay_only) throw new Error("ArgumentValidationError: Object contains extra field `relay_only`");
        return f.deps.request(o);
      },
    });
    expect(r).toMatchObject({ ok: true, mode: "relay" });
    expect(f.requests.map((o) => Object.keys(o).sort())).toEqual([["tailnet", "token_hash"], []]);
  });

  test("relay_only and no offer never open a grant", async () => {
    write("family/notes.md", "hello");
    const f = fleet(path.join(root, "family"));
    const r = await syncFolderFromPeer(path.join(root, "here", "family"), { ...f.deps, direct: async () => null });
    expect(r).toMatchObject({ ok: true, mode: "relay" });
    expect(f.requests[0]).toEqual({});
    const relayOnly = await exportFolder(
      { path: path.join(root, "family"), relay_only: true, direct: { requester: DST, token_hash: "a".repeat(64) } },
      { home: root, upload: async () => "s", tailnetStatus: async () => seenBy(SRC, DST), firewallBlocks: async () => false },
    );
    expect(relayOnly).toMatchObject({ ok: true, storage_id: "s" });
    expect(liveGrantCount()).toBe(0);
  });
});
