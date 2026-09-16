import { describe, expect, test } from "bun:test";
import { CHIEF_OF_STAFF_HANDLE, chiefForward, isChiefAnchor } from "./anchorAlias";

// docs/architecture/org-staffing.md S12: `cast anchor <verb>` forwards to the
// role verbs once the anchor is the chief of staff; a plain anchor is untouched.

describe("cast anchor forwards to the chief of staff", () => {
  const chief = { _id: "anchor-t", org_role_id: "org_roles_cos", name: "Anchor" };

  test("a plain anchor forwards nothing", () => {
    expect(isChiefAnchor({ org_role_id: undefined })).toBe(false);
    expect(chiefForward({}, "wake", { message: "hi" })).toBeNull();
    expect(chiefForward(null, "rm")).toBeNull();
  });

  test("wake becomes role wake with the message and the acting session", () => {
    const fwd = chiefForward(chief, "wake", { message: "what changed?", from_session: "jxactor" })!;
    expect(fwd.route).toBe("/cli/role/wake");
    expect(fwd.body).toEqual({ role_id: "org_roles_cos", message: "what changed?", from_session: "jxactor" });
    expect(fwd.note).toBe(`anchor is now the Chief of Staff (@${CHIEF_OF_STAFF_HANDLE}) · forwarding to cast role wake ${CHIEF_OF_STAFF_HANDLE}`);
  });

  test("brief restarts the role, rm retires it, create and ls only say so", () => {
    expect(chiefForward(chief, "brief")).toMatchObject({ route: "/cli/role/restart", body: { role_id: "org_roles_cos" }, roleVerb: "role restart" });
    expect(chiefForward(chief, "rm")).toMatchObject({ route: "/cli/org/retire", body: { role_id: "org_roles_cos" }, roleVerb: "role retire" });
    expect(chiefForward(chief, "create")).toMatchObject({ route: null, roleVerb: "org staff" });
    expect(chiefForward(chief, "create")!.note).toBe(`anchor is now the Chief of Staff (@${CHIEF_OF_STAFF_HANDLE}) · use cast org staff`);
    expect(chiefForward(chief, "ls")!.note).toBe(`anchor is now the Chief of Staff (@${CHIEF_OF_STAFF_HANDLE}) · use cast role show ${CHIEF_OF_STAFF_HANDLE}`);
  });
});
