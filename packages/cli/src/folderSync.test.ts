import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  exportFolder,
  isSecretFile,
  refusedFolder,
  localFolderFor,
  packFolder,
  planFolderExport,
  syncFolderFromPeer,
  unpackFolder,
  type PeerOutcome,
} from "./folderSync";

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
