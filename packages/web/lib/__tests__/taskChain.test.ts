import { describe, expect, it } from "bun:test";
import { arrangeChain } from "../taskChain";

const NAMES: Record<string, string> = {
  founder: "Ashot",
  sam: "Samvit",
  growth: "Growth",
  platform: "Platform",
  ads: "Ads",
  seo: "Search",
};
const nameOf = (key: string) => NAMES[key] ?? key;

const underUser = (_id: string, user_id: string) => ({ _id, reports_to: { kind: "user" as const, user_id } });
const underRole = (_id: string, role_id: string) => ({ _id, reports_to: { kind: "role" as const, role_id } });

const flat = (nodes: { key: string; depth: number }[]) => nodes.map((n) => `${"  ".repeat(n.depth)}${n.key}`);

describe("arrangeChain", () => {
  it("nests a founder's two roles under the founder, by name", () => {
    const roles = [underUser("platform", "founder"), underUser("growth", "founder")];
    expect(flat(arrangeChain(["platform", "founder", "growth"], roles, { nameOf }))).toEqual([
      "founder",
      "  growth",
      "  platform",
    ]);
  });

  it("nests a role under the role it reports to", () => {
    const roles = [underUser("growth", "founder"), underRole("ads", "growth"), underRole("seo", "growth")];
    expect(flat(arrangeChain(["founder", "growth", "seo", "ads"], roles, { nameOf }))).toEqual([
      "founder",
      "  growth",
      "    ads",
      "    seo",
    ]);
  });

  it("gives a person with no roles a group of their own and nothing under it", () => {
    const roles = [underUser("growth", "founder")];
    expect(flat(arrangeChain(["sam", "growth"], roles, { nameOf }))).toEqual(["founder", "  growth", "sam"]);
  });

  it("adds everyone above a role that holds tasks, even when they hold none", () => {
    // Only the deepest role has work; the founder and the role between them
    // still head it, or the nested group would hang under nothing.
    const roles = [underUser("growth", "founder"), underRole("ads", "growth")];
    expect(flat(arrangeChain(["ads"], roles, { nameOf }))).toEqual(["founder", "  growth", "    ads"]);
  });

  it("leaves out people and roles with no work in their chain", () => {
    const roles = [underUser("growth", "founder"), underUser("platform", "sam")];
    expect(flat(arrangeChain(["growth"], roles, { nameOf }))).toEqual(["founder", "  growth"]);
  });

  it("puts the viewer's chain first, then the rest by name", () => {
    const roles = [underUser("growth", "sam")];
    expect(flat(arrangeChain(["founder", "growth"], roles, { meId: "sam", nameOf }))).toEqual([
      "sam",
      "  growth",
      "founder",
    ]);
  });

  it("lets a role head its own chain when the role above it is gone", () => {
    const roles = [underRole("ads", "removed")];
    expect(flat(arrangeChain(["ads", "founder"], roles, { nameOf }))).toEqual(["ads", "founder"]);
  });

  it("keeps every role on the board when two report to each other", () => {
    const roles = [underRole("ads", "seo"), underRole("seo", "ads")];
    const out = arrangeChain(["ads", "seo"], roles, { nameOf });
    expect(out.map((n) => n.key).sort()).toEqual(["ads", "seo"]);
    expect(out.filter((n) => n.depth === 0)).toHaveLength(1);
  });

  it("reads ids as strings, so a Convex id and its string form agree", () => {
    const roles = [{ _id: { toString: () => "growth" }, reports_to: { kind: "user" as const, user_id: "founder" } }];
    expect(flat(arrangeChain(["growth"], roles, { nameOf }))).toEqual(["founder", "  growth"]);
  });
});
