// Steering a ship plan by flags (`--only`, `--hold`, `--commits-only`,
// `--message`) instead of rewriting .git/codecast/ship-plan.json by hand.
import { describe, expect, test } from "bun:test";
import { steerPlan } from "./shipCheckoutCli.js";
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
