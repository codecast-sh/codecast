// Run: bun test components/org/company/objects.test.ts
import { describe, expect, it } from "bun:test";
import { findGoal, findProject } from "./objects";

describe("finding an object by any ref a link may carry", () => {
  it("a project opened by its stub key follows the server row that supersedes it", () => {
    const stub = { _id: "projstub-1", client_key: "projstub-1", title: "Launch" };
    const real = { _id: "proj0000000000000000000000000000", client_key: "projstub-1", short_id: "pj-7", title: "Launch" };
    expect(findProject([stub], "projstub-1")).toBe(stub);
    expect(findProject([real], "projstub-1")).toBe(real);
    expect(findProject([real], "PJ-7")).toBe(real);
    expect(findProject([real], real._id)).toBe(real);
    expect(findProject([real], "pj-8")).toBeUndefined();
  });

  it("a goal does the same", () => {
    const real = { _id: "goal0000000000000000000000000000", client_key: "instub-1", short_id: "in-3", title: "Grow" } as any;
    expect(findGoal([real], "instub-1")).toBe(real);
    expect(findGoal([real], "in-3")).toBe(real);
  });
});
