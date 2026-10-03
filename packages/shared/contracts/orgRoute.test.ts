import { describe, expect, test } from "bun:test";
import { HEAD_OF_PEOPLE_HANDLE, type LeadRole } from "./orgLead";
import { landingLine, routeWork } from "./orgRoute";

// Where new work lands (org-staffing.md S35): four lines, the first that
// applies decides, and every landing says which.

type Role = LeadRole & { _id: string; handle: string };
const role = (handle: string, project_ids: string[] = [], plan_ids: string[] = []): Role => ({ _id: `role_${handle}`, handle, status: "active", scope: { project_ids, plan_ids }, reports_to: { kind: "user" } });
const head = role(HEAD_OF_PEOPLE_HANDLE);
const growth = role("growth", ["proj_growth"]);
const email = role("cold-email", [], ["plan_warm"]);
const roles = [head, growth, email];

describe("routeWork", () => {
  test("line 1: a named role or person wins over everything", () => {
    const named = routeWork({ to: { kind: "role", role: email }, anchor: { project_id: "proj_growth" } }, roles);
    expect(named).toMatchObject({ line: 1, owner: { kind: "role", role: { handle: "cold-email" } } });
    expect(routeWork({ to: { kind: "user", user_id: "u1" }, starter: "u2" }, roles)).toMatchObject({ line: 1, owner: { kind: "user", user_id: "u1" } });
  });

  test("line 2: an anchored request goes to the role that names its plan, else its project, else the Head of People", () => {
    expect(routeWork({ anchor: { plan_id: "plan_warm", project_id: "proj_growth" } }, roles)).toMatchObject({ line: 2, owner: { role: { handle: "cold-email" } }, why: "@cold-email names its plan" });
    expect(routeWork({ anchor: { project_id: "proj_growth" } }, roles)).toMatchObject({ line: 2, owner: { role: { handle: "growth" } }, why: "@growth names its project" });
    const rest = routeWork({ anchor: { project_id: "proj_billing" } }, roles);
    expect(rest).toMatchObject({ line: 2, owner: { role: { handle: HEAD_OF_PEOPLE_HANDLE } } });
    expect(rest.why).toContain("looks after the rest");
  });

  test("line 2 with a tie returns the watchers as choices and files nothing", () => {
    const ops = role("ops", ["proj_growth"]);
    const r = routeWork({ anchor: { project_id: "proj_growth" } }, [growth, ops]);
    expect(r.owner).toBeNull();
    expect("choices" in r && r.choices.map((x) => x.handle).sort()).toEqual(["growth", "ops"]);
  });

  test("line 3: with no anchor and no name, work stays with whoever started it", () => {
    expect(routeWork({ starter: "u1" }, roles)).toMatchObject({ line: 3, owner: { kind: "user", user_id: "u1" } });
    // An anchor no role covers, in a workspace with no Head of People, also stays with the starter.
    expect(routeWork({ anchor: { project_id: "proj_x" }, starter: "u1" }, [growth])).toMatchObject({ line: 3 });
  });

  test("line 4: a bare request with no starter is for the router", () => {
    expect(routeWork({}, roles)).toMatchObject({ line: 4, owner: null });
    expect(routeWork({ anchor: {} }, roles)).toMatchObject({ line: 4 });
    expect(routeWork({ anchor: { project_id: "proj_x" } }, [growth])).toMatchObject({ line: 4 });
  });

  test("the one-line form names the owner and the line", () => {
    expect(landingLine(routeWork({ anchor: { project_id: "proj_growth" } }, roles))).toBe("→ @growth · line 2: @growth names its project");
    expect(landingLine(routeWork({ starter: "u1" }, roles), () => "Ashot")).toBe("→ Ashot · line 3: no task, plan or project; it stays with whoever started it");
    expect(landingLine(routeWork({}, roles))).toContain("nobody yet");
  });
});
