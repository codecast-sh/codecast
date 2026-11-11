import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleSyncRequest, mapPath, packCommand } from "./syncRequests";
import { requestPath } from "./syncCli";

const where = { localRoot: "/Users/me/src/app", remoteCwd: "/home/ubuntu/work/app/.codecast/worktrees/cloud-1", home: "/Users/me", hostHome: "/home/ubuntu" };

describe("where a pulled path lands", () => {
  test("repo paths map between the laptop checkout and the cloud folder", () => {
    expect(mapPath("packages/web/.env.local", where)).toMatchObject({ from: "/Users/me/src/app/packages/web/.env.local", to: "/home/ubuntu/work/app/.codecast/worktrees/cloud-1/packages/web/.env.local", outside: false });
    expect(mapPath("/Users/me/src/app/assets/", where)).toMatchObject({ rel: "assets", outside: false });
  });

  test("home paths outside the repo land in the host's home", () => {
    expect(mapPath("~/data/export.csv", where)).toMatchObject({ from: "/Users/me/data/export.csv", to: "/home/ubuntu/data/export.csv", outside: true });
    expect(mapPath("/Users/me/.config/tool/x.json", where)).toMatchObject({ to: "/home/ubuntu/.config/tool/x.json", outside: true });
  });

  test("a path that leaves its folder or the home is refused by name", () => {
    expect(() => mapPath("../other/secret", where)).toThrow("leaves the folder");
    expect(() => mapPath("/etc/passwd", where)).toThrow("outside your home folder");
    expect(() => mapPath("~", where)).toThrow("whole home folder");
  });
});

describe("credential stores never travel", () => {
  test("a store, a path inside one, and a folder that holds one are refused by name", () => {
    expect(() => mapPath("~/.ssh", where)).toThrow("is in ~/.ssh, which keeps credentials");
    expect(() => mapPath("~/.aws/credentials", where)).toThrow("is in ~/.aws");
    expect(() => mapPath("/Users/me/.config/gh/hosts.yml", where)).toThrow("is in ~/.config/gh");
    expect(() => mapPath("~/Library/Keychains/login.keychain-db", where)).toThrow("is in ~/Library/Keychains");
    expect(() => mapPath("~/.codecast/config.json", where)).toThrow("is in ~/.codecast");
    expect(() => mapPath("~/.config", where)).toThrow("holds ~/.config/gh");
    expect(() => mapPath("~/Library", where)).toThrow("is in ~/Library");
  });

  test("a repo's own files and folders with a store's name still travel", () => {
    expect(mapPath(".aws/config", where)).toMatchObject({ outside: false });
    expect(mapPath(".codecast/notes.md", where)).toMatchObject({ outside: false });
    expect(mapPath("~/.sshconfig-notes/x", where)).toMatchObject({ outside: true });
  });

  test("a link that resolves into a store is refused, from the repo or from home", () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sync-map-")));
    try {
      const w = { ...where, home, localRoot: path.join(home, "src/app") };
      fs.mkdirSync(path.join(home, ".ssh"));
      fs.mkdirSync(path.join(home, "src/app"), { recursive: true });
      fs.mkdirSync(path.join(home, "data"));
      fs.writeFileSync(path.join(home, ".ssh/id_ed25519"), "key");
      fs.symlinkSync(path.join(home, ".ssh/id_ed25519"), path.join(home, "src/app/notes.txt"));
      fs.symlinkSync(path.join(home, ".ssh"), path.join(home, "data/keys"));
      fs.writeFileSync(path.join(home, "src/app/real.txt"), "x");
      expect(() => mapPath("notes.txt", w)).toThrow("is in ~/.ssh");
      expect(() => mapPath("~/data/keys/known_hosts", w)).toThrow("is in ~/.ssh");
      expect(mapPath("real.txt", w)).toMatchObject({ outside: false });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});

describe("a path as the asking shell names it", () => {
  const host = { cwd: "/home/ubuntu/work/app/.codecast/worktrees/cloud-1/packages/web", repoRoot: "/home/ubuntu/work/app/.codecast/worktrees/cloud-1", home: "/home/ubuntu" };
  test("relative to where it runs becomes relative to the repo", () => {
    expect(requestPath(".env.local", host)).toBe("packages/web/.env.local");
    expect(requestPath("../../README.md", host)).toBe("README.md");
  });
  test("home paths stay home paths, on either machine", () => {
    expect(requestPath("~/data/x.csv", host)).toBe("~/data/x.csv");
    expect(requestPath("/home/ubuntu/data/x.csv", host)).toBe("~/data/x.csv");
  });
  test("a laptop path named from the host passes through for the laptop to read", () => {
    expect(requestPath("/Users/me/data/x.csv", host)).toBe("/Users/me/data/x.csv");
  });
});

describe("what stayed behind, in a few lines", () => {
  test("dependency folders as one count, the rest largest first, and how to fetch", async () => {
    const { skippedLines } = await import("./syncRequests");
    const lines = skippedLines("the laptop checkout", [
      { path: "node_modules/", reason: "rebuilt" },
      { path: "web/node_modules/", reason: "rebuilt" },
      { path: "a.mp4", reason: "media", bytes: 5 * 1048576 },
      { path: "b.mp4", reason: "media", bytes: 30 * 1048576 },
    ], true);
    expect(lines).toEqual([
      "stayed on the laptop checkout:",
      "  2 dependency or build folders (node_modules/, web/node_modules/): rebuilt on each machine",
      "  b.mp4 (30 MB): audio or video, fetched when needed",
      "  a.mp4 (5 MB): audio or video, fetched when needed",
      "  cast sync pull <path> brings any of these here",
    ]);
  });
});

describe("logins and keys outside the stores never travel", () => {
  test("agent auth, browser profiles, Library, git passwords and key-named files are refused by name", () => {
    expect(() => mapPath("~/.claude/.credentials.json", where)).toThrow("is in ~/.claude/.credentials.json");
    expect(() => mapPath("~/.claude.json", where)).toThrow("which keeps credentials");
    expect(() => mapPath("~/.codex/auth.json", where)).toThrow("is in ~/.codex/auth.json");
    expect(() => mapPath("~/Library/Application Support/Google/Chrome/Default/Cookies", where)).toThrow("is in ~/Library");
    expect(() => mapPath("~/.config/google-chrome/Default", where)).toThrow("is in ~/.config/google-chrome");
    expect(() => mapPath("~/.git-credentials", where)).toThrow("which keeps credentials");
    expect(() => mapPath("~/.claude", where)).toThrow("holds ~/.claude");
    expect(() => mapPath("~/deploy/prod.pem", where)).toThrow("named like a key");
    expect(() => mapPath("~/backup/id_ed25519", where)).toThrow("named like a key");
    expect(() => mapPath("~/other-app/.env", where)).toThrow("named like a key");
  });

  test("ordinary home files, other agent config and the repo's own .env still travel", () => {
    expect(mapPath("~/data/export.csv", where)).toMatchObject({ outside: true });
    expect(mapPath("~/.claude/skills/x/SKILL.md", where)).toMatchObject({ outside: true });
    expect(mapPath(".env", where)).toMatchObject({ outside: false });
  });

  test("a link out of the home folder is refused, a missing file under a linked root is not", () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sync-map-")));
    const linked = fs.mkdtempSync(path.join(os.tmpdir(), "sync-link-"));
    try {
      fs.mkdirSync(path.join(home, "src/app"), { recursive: true });
      fs.symlinkSync("/etc/hosts", path.join(home, "src/app/hosts"));
      fs.symlinkSync(path.join(home, "src"), path.join(linked, "src"));
      const w = { ...where, home, localRoot: path.join(home, "src/app") };
      expect(() => mapPath("hosts", w)).toThrow("resolves outside your home folder");
      expect(mapPath("not-yet.txt", { ...w, localRoot: path.join(linked, "src/app") })).toMatchObject({ outside: false });
    } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(linked, { recursive: true, force: true }); }
  });

  test("a folder from outside the repo leaves keys out of the tar; the repo's folders go whole", () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sync-pack-")));
    try {
      fs.mkdirSync(path.join(home, "data/nested/.ssh"), { recursive: true });
      for (const f of ["data/a.csv", "data/nested/b.csv", "data/nested/server.pem", "data/nested/.env", "data/nested/.ssh/id_ed25519"]) fs.writeFileSync(path.join(home, f), "x");
      const list = (outside: boolean) => require("node:child_process").execSync(`${packCommand(home, ["data"], outside)} | tar -tf -`, { env: { ...process.env, COPYFILE_DISABLE: "1" } }).toString().split("\n").filter((l: string) => l && !l.endsWith("/")).sort();
      expect(list(true)).toEqual(["data/a.csv", "data/nested/b.csv"]);
      expect(list(false)).toHaveLength(5);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});

describe("only this laptop's own checkouts are served", () => {
  test("a local_root the laptop never reported is refused before anything is read", async () => {
    const deps = { jobs: {} as any, hostFor: () => ({ user: "u", address: "h" }) as any, scopeFor: () => undefined, isProjectRoot: async (r: string) => r === "/Users/me/src/app" };
    await expect(handleSyncRequest({ op: "diff", conversation_id: "c", host_device_id: "d", remote_cwd: "/w", local_root: "/Users/me", paths: [".ssh/id_rsa"] }, deps)).rejects.toThrow("not a project checkout on this laptop");
  });
});
