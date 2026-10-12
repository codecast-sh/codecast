import { describe, expect, test } from "bun:test";
import { buildEntityUrl, entityRoute, objectHref, orgObjectOfRef, parseEntityUrl, personRefOf } from "./index";

// A goal, a project, a role and a person each have one address, the Org
// screen with that object's sheet open.
describe("the company's objects", () => {
  test("every kind addresses /org/<ref>, a person by handle", () => {
    expect(objectHref("initiative", "in-2")).toBe("/org/in-2");
    expect(objectHref("project", "pj-mf3k2a")).toBe("/org/pj-mf3k2a");
    expect(objectHref("role", "or-7")).toBe("/org/or-7");
    expect(objectHref("person", "samvit")).toBe("/org/@samvit");
    expect(objectHref("person", "@samvit")).toBe("/org/@samvit");
    expect(personRefOf({ _id: "u1", github_username: "samvit" })).toBe("samvit");
    expect(personRefOf({ _id: "u1" })).toBe("u1");
  });

  test("entityRoute and the public URL delegate to the same address", () => {
    expect(entityRoute("initiative", "in-7")).toBe("/org/in-7");
    expect(entityRoute("goals", "in-7")).toBe("/org/in-7");
    expect(entityRoute("role", "or-4")).toBe("/org/or-4");
    expect(entityRoute("person", "samvit")).toBe("/org/@samvit");
    expect(buildEntityUrl("project", "pj-abc")).toBe("https://codecast.sh/org/pj-abc");
  });

  test("an /org/<ref> link reads back as the object it names", () => {
    expect(parseEntityUrl("/org/in-2")).toEqual({ type: "initiative", id: "in-2" });
    expect(parseEntityUrl("/org/OR-7")).toEqual({ type: "role", id: "or-7" });
    expect(parseEntityUrl("https://codecast.sh/org/pj-mf3k2a")).toEqual({ type: "project", id: "pj-mf3k2a" });
    expect(parseEntityUrl("/org/@samvit")).toEqual({ type: "person", id: "samvit" });
    expect(parseEntityUrl("/org/%40samvit")).toEqual({ type: "person", id: "samvit" });
  });

  test("the rest of /org stays what it was", () => {
    expect(parseEntityUrl("/org?proposal=op-3")).toEqual({ type: "proposal", id: "op-3" });
    expect(parseEntityUrl("/org/workspace")).toBeNull();
    expect(parseEntityUrl("/org")).toBeNull();
    expect(orgObjectOfRef("workspace")).toBeNull();
    expect(orgObjectOfRef("@")).toBeNull();
    expect(orgObjectOfRef("or-else")).toBeNull();
  });

  test("old goal and board links still name their object", () => {
    expect(parseEntityUrl("/goals/in-7")).toEqual({ type: "initiative", id: "in-7" });
    expect(parseEntityUrl("/projects/pj-abc")).toEqual({ type: "project", id: "pj-abc" });
  });
});
