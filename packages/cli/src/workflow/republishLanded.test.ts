// A change that lands .codecast/line.toml or deploy.toml republishes them from a clean worktree of the merged commit
// (republishLanded.ts): the server's copy moved on nothing else, and the run's checkout may never hold the commit.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { landsConfig, republishLanded, unknownKeys, withMergedTree } from "./republishLanded";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1", HOME: os.tmpdir() };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: ENV, encoding: "utf8" }).trim();
const write = (root: string, rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

let dir = "", checkout = "", landed = "";
beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-republish-")));
  checkout = path.join(dir, "checkout");
  fs.mkdirSync(checkout);
  git(checkout, "init", "-q", "-b", "main");
  write(checkout, ".codecast/line.toml", "[line]\nproject = \"P\"\n");
  git(checkout, "add", "-A");
  git(checkout, "commit", "-qm", "base");
  // The change lands on main from elsewhere; the checkout has not moved onto it yet.
  const other = path.join(dir, "other");
  git(dir, "clone", "-q", checkout, other);
  write(other, ".codecast/line.toml", "[line]\nproject = \"Q\"\n");
  git(other, "commit", "-qam", "landed");
  landed = git(other, "rev-parse", "HEAD");
  git(checkout, "fetch", "-q", other, "main");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("republishLanded", () => {
  test("only the line profile, deploy targets and workspace manifest call for it", () => {
    expect(landsConfig(["packages/web/a.ts", ".codecast/check.toml"])).toBe(false);
    for (const f of [".codecast/line.toml", ".codecast/deploy.toml", ".codecast/workspace.toml", ".codecast/line/ship.md"]) expect(landsConfig([f])).toBe(true);
  });

  test("publishes from a clean worktree of the merged commit the checkout has not caught up with, then removes it", async () => {
    let seen = "";
    const words = await republishLanded(landed, {
      tree: (fn) => withMergedTree(checkout, landed, fn),
      unknown: unknownKeys,
      publish: async (d) => { seen = fs.readFileSync(path.join(d, ".codecast/line.toml"), "utf8"); expect(git(d, "rev-parse", "HEAD")).toBe(landed); return { republished: "all" as const }; },
      version: "v1.0.0",
    });
    expect(words).toBe("Republished the line profile and deploy targets it changed.");
    expect(seen).toContain("\"Q\"");
    // The checkout itself never moved, and no worktree is left behind.
    expect(fs.readFileSync(path.join(checkout, ".codecast/line.toml"), "utf8")).toContain("\"P\"");
    expect(git(checkout, "worktree", "list").split("\n")).toHaveLength(1);
  });

  test("a cast that does not read a key the files name publishes nothing and names the cast that can", async () => {
    let published = false;
    const io = { tree: async <T,>(fn: (d: string) => Promise<T>) => fn("/tree"), unknown: async () => [".codecast/deploy.toml: target cli: 'warm' is not a key this cast reads"], publish: async () => { published = true; return { republished: "all" as const }; }, version: "v1.1.300" };
    const words = await republishLanded(landed, io);
    expect(published).toBe(false);
    expect(words).toContain("this cast (v1.1.300) does not read a key they name");
    expect(words).toContain(`A cast released from ${landed.slice(0, 7)} or later publishes them`);
    expect(await unknownKeys(checkout)).toEqual([]);
  });

  test("a failed publish says why; a tree that cannot be made names the command", async () => {
    const io = { tree: async <T,>(fn: (d: string) => Promise<T>) => fn("/tree"), unknown: async () => [], version: "v1" };
    expect(await republishLanded(landed, { ...io, publish: async () => ({ republished: "none" as const, why: "both publishes failed" }) })).toBe("The line profile and deploy targets it changed were not republished: both publishes failed.");
    expect(await republishLanded(landed, { ...io, publish: async () => ({ republished: "targets" as const, why: "cast line profile --publish failed at abc1234" }) })).toBe("Republished the deploy targets it changed; the line profile was not: cast line profile --publish failed at abc1234.");
    const none = await republishLanded(landed, { ...io, tree: async () => { throw new Error("fatal: invalid reference"); }, publish: async () => ({ republished: "all" as const }) });
    expect(none).toBe(`The line profile and deploy targets it changed were not republished: a worktree of ${landed.slice(0, 7)} could not be made (fatal: invalid reference). \`cast line profile --publish\` in a checkout at ${landed.slice(0, 7)} publishes them.`);
  });
});
