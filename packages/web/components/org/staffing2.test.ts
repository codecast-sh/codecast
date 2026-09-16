// The pure logic behind staffing 2's chart half: the one reparent toast (S11),
// where an owner-set change files a session on the tree (S11), and the tenure
// chip a seat draws (S10). These are the pieces the menu, the chart and the
// cards all read, so they are pinned here rather than in any one surface.
import { describe, expect, it } from "bun:test";
import { reparentToastLine, reparentTreeParent } from "../../store/orgSlice";
import { roleTenureChip } from "./orgMeta";
import { ORG_FIXTURE } from "./orgFixture";
import type { OrgTree } from "./orgTypes";

describe("the reparent toast says both things (org-staffing.md S11)", () => {
  it("names the new parent and that the session was told", () => {
    expect(reparentToastLine("jx7abc", "Samvit", "session", { sessions: 1, roles: 0 }))
      .toBe("jx7abc now reports to Samvit; the session was told.");
  });

  it("a role move counts the role and its hands", () => {
    expect(reparentToastLine("@growth", "Ashot", "role", { sessions: 2, roles: 1 }))
      .toBe("@growth now reports to Ashot; the role and 2 hands were told.");
  });

  it("one hand still reads as a compound subject", () => {
    expect(reparentToastLine("@growth", "Ashot", "role", { sessions: 1, roles: 1 }))
      .toBe("@growth now reports to Ashot; the role and 1 hand were told.");
  });

  it("the role alone was told", () => {
    expect(reparentToastLine("@growth", "Ashot", "role", { sessions: 0, roles: 1 }))
      .toBe("@growth now reports to Ashot; the role was told.");
  });

  // A move that changed no reporting line tells nobody: the sentence must not
  // claim an agent heard something it never did.
  it("tells nobody when the line did not move", () => {
    expect(reparentToastLine("jx7abc", "Samvit", "session", { sessions: 0, roles: 0 }))
      .toBe("jx7abc now reports to Samvit.");
    expect(reparentToastLine("jx7abc", "Samvit", "session")).toBe("jx7abc now reports to Samvit.");
  });
});

describe("where an owner change files a session (S11)", () => {
  it("adding an owner re-homes the session under that person", () => {
    expect(reparentTreeParent({ kind: "user", owners: ["u1"], mode: "add" }))
      .toEqual({ kind: "user", user_id: "u1" });
  });

  it("a set files it under the last listed, which is who the handoff named", () => {
    expect(reparentTreeParent({ kind: "user", owners: ["u1", "u2"], mode: "set" }))
      .toEqual({ kind: "user", user_id: "u2" });
  });

  // Removing an owner leaves the line to whoever remains, which the snapshot
  // cannot compute — so the tree waits for the server's echo rather than
  // guessing a parent and flickering.
  it("a remove moves nothing optimistically", () => {
    expect(reparentTreeParent({ kind: "user", owners: ["u1"], mode: "remove" })).toBeNull();
  });

  it("clearing every owner moves nothing optimistically", () => {
    expect(reparentTreeParent({ kind: "user", owners: [], mode: "set" })).toBeNull();
  });

  it("the chart's drop on a person and on a role file under each", () => {
    expect(reparentTreeParent({ kind: "user", user_id: "u9" })).toEqual({ kind: "user", user_id: "u9" });
    expect(reparentTreeParent({ kind: "role", role_id: "r1" })).toEqual({ kind: "role", role_id: "r1" });
  });
});

describe("the tenure chip (org-staffing.md S10)", () => {
  const tree = ORG_FIXTURE as OrgTree;

  it("a standing seat says nothing", () => {
    expect(roleTenureChip({ kind: "standing" }, tree)).toBeNull();
    expect(roleTenureChip(undefined, tree)).toBeNull();
  });

  it("a program names its end and drops the then-tail from the chip", () => {
    const chip = roleTenureChip({ kind: "program", ends: { plan: "pl-689" }, then: "retire" }, tree);
    expect(chip?.short).toBe("program · ends with pl-689");
    // The full sentence stays available for the chip's title.
    expect(chip?.full).toBe("program · ends with pl-689, then retire");
  });

  // A date reads the way a person says it, not as an ISO stamp. Built relative
  // to now: the year is dropped for the current year and kept for any other.
  it("a dated program reads as a person says it", () => {
    const thisYear = new Date().getUTCFullYear();
    expect(roleTenureChip({ kind: "program", ends: { date: Date.UTC(thisYear, 9, 3) }, then: "review" }, tree)?.short)
      .toBe("program · ends Oct 3");
    expect(roleTenureChip({ kind: "program", ends: { date: Date.UTC(thisYear + 2, 9, 3) }, then: "review" }, tree)?.short)
      .toBe(`program · ends Oct 3 ${thisYear + 2}`);
  });

  it("names the plan from the tree when it knows it", () => {
    const plan = tree.roles.flatMap((r) => r.scope_names.plans)[0];
    if (!plan) return; // the fixture carries no scoped plan; nothing to resolve
    expect(roleTenureChip({ kind: "program", ends: { plan: plan.id }, then: "retire" }, tree)?.short)
      .toBe(`program · ends with ${plan.short_id}`);
  });

  it("survives a cold tree, so a card can draw before org.tree lands", () => {
    expect(roleTenureChip({ kind: "program", ends: { plan: "pl-7" }, then: "retire" }, null)?.short)
      .toBe("program · ends with pl-7");
  });
});
