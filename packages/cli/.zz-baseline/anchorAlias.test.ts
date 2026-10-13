import { describe, expect, test } from "bun:test";
import { HEAD_OF_PEOPLE_HANDLE, headForward, isSeatedAnchor } from "./anchorAlias";

// docs/architecture/org-staffing.md S12: `cast anchor <verb>` forwards to the
// role verbs once the anchor is the head of people; a plain anchor is untouched.

describe("cast anchor forwards to the head of people", () => {
  const head = { _id: "anchor-t", org_role_id: "org_roles_cos", name: "Anchor" };

  test("a plain anchor forwards nothing", () => {
    expect(isSeatedAnchor({ org_role_id: undefined })).toBe(false);
    expect(headForward({}, "wake", { message: "hi" })).toBeNull();
    expect(headForward(null, "rm")).toBeNull();
  });

  test("wake becomes role wake with the message and the acting session", () => {
    const fwd = headForward(head, "wake", { message: "what changed?", from_session: "jxactor" })!;
    expect(fwd.route).toBe("/cli/role/wake");
    expect(fwd.body).toEqual({ role_id: "org_roles_cos", message: "what changed?", from_session: "jxactor" });
    expect(fwd.note).toBe(`the workspace's agent is its root role (@${HEAD_OF_PEOPLE_HANDLE}) · forwarding to cast role wake ${HEAD_OF_PEOPLE_HANDLE}`);
  });

  test("brief restarts the role, rm retires it, create and ls only say so", () => {
    expect(headForward(head, "brief")).toMatchObject({ route: "/cli/role/restart", body: { role_id: "org_roles_cos" }, roleVerb: "role restart" });
    // rm takes the agent down with the seat; the role verb's default would keep it running.
    expect(headForward(head, "rm")).toMatchObject({ route: "/cli/org/retire", body: { role_id: "org_roles_cos", standing_session: "retire" }, roleVerb: "role retire" });
    expect(headForward(head, "brief")!.body).toEqual({ role_id: "org_roles_cos" });
    expect(headForward(head, "create")).toMatchObject({ route: null, roleVerb: "org staff" });
    expect(headForward(head, "create")!.note).toBe(`the workspace's agent is its root role (@${HEAD_OF_PEOPLE_HANDLE}) · use cast org staff`);
    expect(headForward(head, "ls")!.note).toBe(`the workspace's agent is its root role (@${HEAD_OF_PEOPLE_HANDLE}) · use cast role show ${HEAD_OF_PEOPLE_HANDLE}`);
  });
});
