import { describe, expect, test } from "bun:test";
import { assertGlance } from "./glance";
import { CALL_REACHES, PAGE_REACHES, destroyTeamLedger, mayDeletePermanently, permanentDeleteLedger, regulatedTeam, SESSION_REACHES } from "../deletionLedgers";

const teams = [
  { _id: "t1", name: "Acme Health", role: "admin", policy: { regulated_data: true } },
  { _id: "t2", name: "Bravo", role: "member", policy: { regulated_data: true } },
  { _id: "t3", name: "Plain", role: "admin", policy: {} },
];

describe("deletion ledgers", () => {
  test("only a regulated team answers, with the viewer's admin role", () => {
    expect(regulatedTeam(teams, "t1")).toEqual({ name: "Acme Health", admin: true });
    expect(regulatedTeam(teams, "t2")).toEqual({ name: "Bravo", admin: false });
    expect(regulatedTeam(teams, "t3")).toBeNull();
    expect(regulatedTeam(teams, undefined)).toBeNull();
  });

  test("the owner or an admin may delete", () => {
    expect(mayDeletePermanently({ admin: false }, "u1", "u1")).toBe(true);
    expect(mayDeletePermanently({ admin: false }, "u1", "u2")).toBe(false);
    expect(mayDeletePermanently({ admin: true }, "u1", "u2")).toBe(true);
  });

  test("a destroy asks for the team's name, shows counts, and says it cannot be undone", () => {
    const l = destroyTeamLedger({
      team: "Acme Health",
      preview: { team_name: "Acme Health", sessions: { n: 250, more: true }, calls: { n: 3, more: false }, tasks: { n: 0, more: false }, docs: { n: 1, more: false }, plans: { n: 2, more: false }, members: { n: 4, more: false } },
    });
    expect(l.typed).toEqual({ k: "Team name", expect: "Acme Health" });
    expect(l.alert).toBe("Can't be undone");
    expect(l.figures.map((f) => f.value)).toEqual(["250+", "3", "0", "1", "2"]);
    expect(l.blocked).toBeUndefined();
    expect(destroyTeamLedger({ team: "Acme Health", preview: null }).blocked).toBeTruthy();
  });

  test("an object delete names it and lists what goes", () => {
    const l = permanentDeleteLedger({ what: "session", count: 2, title: "2 sessions", team: "Acme Health", reaches: SESSION_REACHES });
    expect(l.name).toBe("Delete 2 sessions permanently");
    expect(l.rows.find((r) => r.k === "Deletes")?.list).toEqual(SESSION_REACHES);
  });
});

test("every deletion review fits a glance", () => {
  assertGlance(destroyTeamLedger({ team: "Acme Health", preview: undefined }));
  assertGlance(destroyTeamLedger({ team: "Acme Health", preview: null }));
  for (const [what, reaches] of [["session", SESSION_REACHES], ["page", PAGE_REACHES], ["call", CALL_REACHES]] as const) {
    assertGlance(permanentDeleteLedger({ what, title: "Intake", team: "Acme Health", reaches: [...reaches], figures: [{ value: "12", label: "messages" }] }));
  }
});
