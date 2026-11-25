import { describe, expect, test } from "bun:test";
import { cleanProfilePatch, normalizeLabels, personLongLines, personShortLine, PROFILE_TITLE_MAX } from "./personProfile";
import { orgWhereLines, type OrgWhere } from "./orgWhere";

describe("person profiles", () => {
  test("labels are lower case, dashed, deduped, comma lists split", () => {
    expect(normalizeLabels(["Sales, #Design", "go to market", "sales"])).toEqual(["sales", "design", "go-to-market"]);
  });

  test("a title past the limit is refused, empty strings stay as clears", () => {
    expect(cleanProfilePatch({ title: "x".repeat(PROFILE_TITLE_MAX + 1) }).ok).toBe(false);
    expect(cleanProfilePatch({ title: "", focus: "  evals,   agent quality " })).toEqual({ ok: true, patch: { title: "", focus: "evals, agent quality" } });
  });

  test("the short line names who, title, focus and manager", () => {
    expect(personShortLine({ name: "Jason Benn", handle: "jasonbenn", role: "member", title: "Head of Agentic Quality", focus: "evals, agent quality", reports_to: "Ashot Petrosian" }))
      .toBe("Jason Benn @jasonbenn · Head of Agentic Quality · evals, agent quality · reports to Ashot Petrosian");
    expect(personShortLine({ name: "Cam", role: "admin", is_me: true, labels: ["calling"] })).toBe("Cam (admin, your person) · calling");
  });

  test("the long version says how to set a missing profile", () => {
    const lines = personLongLines({ name: "Cam", handle: "cameron", areas: [], takes_decisions: true, reports_to: [], reports: [], roles: [], profile_updated: null });
    expect(lines.join("\n")).toContain('cast org person @cameron --title');
  });

  test("org where prints one line per person", () => {
    const w: OrgWhere = {
      workspace: { kind: "team", id: "t", name: "Acme" },
      session: null,
      work: { task: null, plan: null, project: null },
      seat: { how: "none", handles: [] },
      card: null,
      chain: [],
      roles: [],
      people: [
        { name: "Ana", handle: "ana", role: "admin", is_me: true, title: "Founder", focus: "product" },
        { name: "Bo", role: "member", is_me: false, reports_to: "Ana" },
      ],
    };
    const lines = orgWhereLines(w);
    expect(lines).toContain("  Ana @ana (admin, your person) · Founder · product");
    expect(lines).toContain("  Bo · reports to Ana");
  });
});
