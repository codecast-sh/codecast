// A change that lands .codecast/line.toml or deploy.toml republishes them from the run's checkout once it holds the
// merged commit (republishLanded.ts): the server's copy moved on nothing else.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { landsConfig, notYetHeld, republishLanded } from "./republishLanded";

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

  test("a checkout publishes only once its HEAD holds the merged commit with .codecast clean", async () => {
    expect(await notYetHeld(checkout, landed)).toContain("does not hold");
    git(checkout, "merge", "-q", "--ff-only", landed);
    write(checkout, ".codecast/line.toml", "[line]\nproject = \"mine\"\n");
    expect(await notYetHeld(checkout, landed)).toContain("uncommitted edits");
    git(checkout, "checkout", "-q", "--", ".codecast/line.toml");
    expect(await notYetHeld(checkout, landed)).toBeNull();
  });

  test("waits for the checkout to hold it, then publishes once and says so", async () => {
    let now = 0;
    let looks = 0;
    const published: number[] = [];
    const words = await republishLanded("/repo", landed, {
      held: async () => (++looks < 3 ? "the checkout's HEAD does not hold it yet" : null),
      publish: async () => { published.push(now); return null; },
      sleep: async (ms) => { now += ms; },
      now: () => now,
    }, { intervalMs: 30_000, deadline: 10 * 60_000 });
    expect(published).toEqual([60_000]);
    expect(words).toBe("Republished the line profile and deploy targets it changed.");
  });

  test("a checkout that never holds it is named with the command that publishes by hand; a failed publish says why", async () => {
    let now = 0;
    const io = { held: async () => "the checkout's HEAD does not hold it yet", publish: async () => { throw new Error("never"); }, sleep: async (ms: number) => { now += ms; }, now: () => now };
    const words = await republishLanded("/repo", landed, io, { intervalMs: 30_000, deadline: 10 * 60_000 });
    expect(words).toBe(`The line profile and deploy targets it changed were not republished: the checkout's HEAD does not hold it yet. Run \`cast line profile --publish\` in /repo once it holds ${landed.slice(0, 7)}.`);
    expect(now).toBe(10 * 60_000);
    const failed = await republishLanded("/repo", landed, { ...io, held: async () => null, publish: async () => "both publishes failed" }, { intervalMs: 1, deadline: 0 });
    expect(failed).toBe("The line profile and deploy targets it changed were not republished: both publishes failed.");
  });
});
