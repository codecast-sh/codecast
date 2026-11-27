// A change that lands .codecast/line.toml or deploy.toml republishes them from a clean worktree of the merged commit
// (republishLanded.ts): the server's copy moved on nothing else, and the run's checkout may never hold the commit.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { castVersionNeeded, landsConfig, republishLanded, unknownKeys, withMergedTree } from "./republishLanded";

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
      publish: async (d) => { seen = fs.readFileSync(path.join(d, ".codecast/line.toml"), "utf8"); expect(git(d, "rev-parse", "HEAD")).toBe(landed); return { republished: "all" as const }; },
    });
    expect(words).toBe("Republished the line profile and deploy targets it changed.");
    expect(seen).toContain("\"Q\"");
    // The checkout itself never moved, and no worktree is left behind.
    expect(fs.readFileSync(path.join(checkout, ".codecast/line.toml"), "utf8")).toContain("\"P\"");
    expect(git(checkout, "worktree", "list").split("\n")).toHaveLength(1);
    expect(await unknownKeys(checkout)).toEqual([]);
  });

  test("a publishing cast that does not read a key the files name publishes nothing, and the words name the cast that does", async () => {
    const tree = async <T,>(fn: (d: string) => Promise<T>) => fn("/tree");
    const unknown = [".codecast/deploy.toml: target cli: 'warm' is not a key this cast reads"];
    const words = await republishLanded(landed, { tree, publish: async () => ({ republished: "refused" as const, version: "v1.1.300", unknown, needed: "v1.1.320" }) });
    expect(words).toBe(`The line profile and deploy targets it changed were not republished: the cast that publishes them (v1.1.300) does not read a key they name and would drop it (${unknown[0]}). cast v1.1.320 or later reads it: \`cast update\`, then \`cast line profile --publish\` in a checkout at ${landed.slice(0, 7)}.`);
    expect(await republishLanded(landed, { tree, publish: async () => ({ republished: "refused" as const, version: "v2", unknown: ["a", "b"], needed: null }) })).toContain("does not read 2 keys they name and would drop them (a). A newer cast that reads them publishes them");
  });

  test("--strict refuses with what the publishing cast would drop, and exits 3", async () => {
    const tree = path.join(dir, "strict");
    write(tree, ".codecast/deploy.toml", "[[target]]\nname = \"cli\"\nrun = \"x.sh\"\nwarm = \"5m\"\n");
    const unknown = await unknownKeys(tree);
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toContain("'warm' is not a key this cast reads");
    const { refuseUnknownKeys } = await import("../lineProfileCommand");
    const out: string[] = [];
    const log = console.log, exit = process.exit;
    console.log = (l: string) => { out.push(l); };
    (process as any).exit = (code: number) => { throw new Error(`exit ${code}`); };
    try {
      await expect(refuseUnknownKeys(tree)).rejects.toThrow("exit 3");
      await refuseUnknownKeys(checkout);
    } finally {
      console.log = log;
      (process as any).exit = exit;
    }
    expect(JSON.parse(out[0])).toMatchObject({ refused: "unknown_keys", unknown });
    expect(out).toHaveLength(1);
  });

  test("the cast needed is the release after the version codecast's own tree holds; other repositories name none", () => {
    write(dir, "codecast/packages/cli/package.json", JSON.stringify({ name: "@codecast/cli", version: "1.1.319" }));
    expect(castVersionNeeded(path.join(dir, "codecast"))).toBe("v1.1.320");
    write(dir, "other/packages/cli/package.json", JSON.stringify({ name: "other-cli", version: "2.0.0" }));
    expect(castVersionNeeded(path.join(dir, "other"))).toBeNull();
    expect(castVersionNeeded(checkout)).toBeNull();
  });

  test("a failed publish says why; a tree that cannot be made names the command", async () => {
    const tree = async <T,>(fn: (d: string) => Promise<T>) => fn("/tree");
    expect(await republishLanded(landed, { tree, publish: async () => ({ republished: "none" as const, why: "both publishes failed" }) })).toBe("The line profile and deploy targets it changed were not republished: both publishes failed.");
    expect(await republishLanded(landed, { tree, publish: async () => ({ republished: "targets" as const, why: "cast line profile --publish failed at abc1234" }) })).toBe("Republished the deploy targets it changed; the line profile was not: cast line profile --publish failed at abc1234.");
    const none = await republishLanded(landed, { tree: async () => { throw new Error("fatal: invalid reference"); }, publish: async () => ({ republished: "all" as const }) });
    expect(none).toBe(`The line profile and deploy targets it changed were not republished: a worktree of ${landed.slice(0, 7)} could not be made (fatal: invalid reference). \`cast line profile --publish\` in a checkout at ${landed.slice(0, 7)} publishes them.`);
  });
});
