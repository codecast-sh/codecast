import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mapPath } from "./syncRequests";
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
    expect(() => mapPath("~/Library", where)).toThrow("holds ~/Library/Keychains");
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
      expect(() => mapPath("~/data/keys/id_ed25519", w)).toThrow("is in ~/.ssh");
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
