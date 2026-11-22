// Steering a ship plan by flags (`--only`, `--hold`, `--commits-only`,
// `--message`) instead of rewriting .git/codecast/ship-plan.json by hand.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseManifestText } from "../workspace/manifest.js";
import { checkoutFlowArgs, runCheckoutCommand, steerPlan } from "./shipCheckoutCli.js";
import { defaultMessage, type ShipGroup, type ShipPlan } from "./shipCheckout.js";

const group = (id: string, over: Partial<ShipGroup> = {}): ShipGroup => ({
  id, session: null, message: `feat(x): ${id}`, paths: [`${id}.ts`], ship: id !== "credentials", stat: { files: 1, added: 1, removed: 0 }, last_edit: null, ...over,
});
const plan = (): ShipPlan => ({
  version: 1, root: "/r", created_at: "", base: "b", tree: "t", upstream: "origin/main", mode: "direct", local_commits: [], behind: 0,
  groups: [group("s:jx7abc1"), group("s:jx7def2"), group("unattributed"), group("credentials")],
  attribution: { files: 4, attributed: 2, took_ms: 0 },
});
const shipping = (p: ShipPlan) => p.groups.filter((g) => g.ship).map((g) => g.id);

describe("steerPlan", () => {
  test("--only ships the named groups (by id, bare session id or prefix) and holds the rest", () => {
    const p = plan();
    expect(steerPlan(p, { only: "jx7abc1,unat" })).toBe(true);
    expect(shipping(p)).toEqual(["s:jx7abc1", "unattributed"]);
  });

  test("--hold holds; --commits-only holds every group; neither changes an already held plan", () => {
    const p = plan();
    steerPlan(p, { hold: "s:jx7def2" });
    expect(shipping(p)).toEqual(["s:jx7abc1", "unattributed"]);
    steerPlan(p, { commitsOnly: true });
    expect(shipping(p)).toEqual([]);
    expect(steerPlan(p, { commitsOnly: true })).toBe(false);
  });

  test("--message sets a group's message, the text taken whole after the first =", () => {
    const p = plan();
    steerPlan(p, { message: ["jx7def2=fix(cli): a = b in CI"] });
    expect(p.groups[1]!.message).toBe("fix(cli): a = b in CI");
  });

  test("a name no group has, an ambiguous prefix, a bare --message and --only with --commits-only are refused", () => {
    expect(() => steerPlan(plan(), { hold: "jx7zzz" })).toThrow('No group "jx7zzz" in the plan; its groups: s:jx7abc1, s:jx7def2, unattributed, credentials');
    expect(() => steerPlan(plan(), { hold: "jx7" })).toThrow("names 2 groups");
    expect(() => steerPlan(plan(), { message: ["jx7abc1"] })).toThrow("--message takes <group>=<message>");
    expect(() => steerPlan(plan(), { only: "jx7abc1", commitsOnly: true })).toThrow("--commits-only");
  });
});

describe("defaultMessage", () => {
  test("lowercases a capitalized first word but keeps an acronym", () => {
    expect(defaultMessage("CI web failures", ["packages/web/a.ts"])).toBe("feat(web): CI web failures");
    expect(defaultMessage("Fix the CI web failures", ["packages/web/a.ts"])).toBe("fix(web): fix the CI web failures");
    expect(defaultMessage("A tidy pass", ["packages/web/a.ts"])).toBe("feat(web): a tidy pass");
  });
});

describe("[ship] flow: a pass runs through a flow", () => {
  test("the manifest takes a flow's name, and refuses \"default\", an empty or a non-string one", () => {
    expect(parseManifestText(`[ship]\nflow = "change"\n`).ship?.flow).toBe("change");
    expect(() => parseManifestText(`[ship]\nflow = "default"\n`)).toThrow("never takes a workspace's default flow");
    expect(parseManifestText(`[ship]\nmode = "direct"\n`).ship?.flow).toBeUndefined();
    expect(() => parseManifestText(`[ship]\nflow = ""\n`)).toThrow("'ship.flow' must name a flow");
    expect(() => parseManifestText(`[ship]\nflow = 3\n`)).toThrow("'ship.flow' must name a flow");
  });

  test("a [ship] key a newer cast reads is ignored and named, so an older cast still reads the manifest", () => {
    const ship = parseManifestText(`[ship]\nmode = "direct"\nfuture_key = 1\nother = "x"\n`).ship;
    expect(ship?.mode).toBe("direct");
    expect(ship?.ignored).toEqual(["future_key", "other"]);
    expect(parseManifestText(`[ship]\nmode = "direct"\n`).ship?.ignored).toBeUndefined();
  });

  test("set, the pass is the named flow's checkout change; a dry run only plans; steering flags and --no-fetch are refused", () => {
    expect(checkoutFlowArgs(undefined, {})).toBeNull();
    expect(checkoutFlowArgs("change", {})).toEqual(["flow", "run", "change", "--checkout"]);
    expect(checkoutFlowArgs("  change \n", {})).toEqual(["flow", "run", "change", "--checkout"]);
    expect(checkoutFlowArgs("   ", {})).toBeNull();
    expect(checkoutFlowArgs("change", { json: true })).toEqual(["flow", "run", "change", "--checkout", "--json"]);
    expect(() => checkoutFlowArgs("change", { fetch: false })).toThrow("--no-fetch only steers");
    expect(checkoutFlowArgs("change", { dryRun: true })).toBeNull();
    expect(() => checkoutFlowArgs("change", { hold: "s:jx7abc1", push: false })).toThrow("--hold, --no-push only steer a pass cast ship checkout pushes itself");
    expect(() => checkoutFlowArgs("change", { plan: true })).toThrow("--plan only steers");
  });

  test("cast ship checkout with a flow set runs the flow in the checkout and pushes nothing itself", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-ship-flow-")));
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env, encoding: "utf-8" });
    git("init", "-q", "-b", "main");
    fs.mkdirSync(path.join(root, ".codecast"));
    fs.writeFileSync(path.join(root, ".codecast", "workspace.toml"), `[ship]\nmode = "direct"\nflow = "change"\n`);
    git("add", "-A");
    git("commit", "-qm", "base");
    fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
    const cwd = process.cwd();
    const ran: Array<{ args: string[]; cwd: string }> = [];
    const records: unknown[] = [];
    process.chdir(root);
    try {
      // No origin here: a pass this command pushed itself would stop at its plan; the flow's run is all that happens.
      await runCheckoutCommand({}, async (body) => { records.push(body); }, async (args, at) => { ran.push({ args, cwd: at }); return 0; });
    } finally {
      process.chdir(cwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
    expect(ran).toEqual([{ args: ["flow", "run", "change", "--checkout"], cwd: root }]);
    expect(records).toEqual([]);
  });
});
