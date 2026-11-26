// Absolute rank's endpoints are gone for good (relative rank replaced them):
// no route or function answers under their old names, so an old CLI fails
// plainly instead of writing a rank nothing reads. The convex deploy that
// carries this ships with the CLI release that calls /cli/priorities/move.
import { describe, expect, test } from "bun:test";
import * as priorities from "../priorities";
import { registerPriorityRoutes } from "./priorityRoutes";

describe("the removed rank endpoints", () => {
  test("no /cli/priorities/rank route, and no rank or cliRank function", () => {
    const paths: string[] = [];
    registerPriorityRoutes({ route: (spec: { path: string }) => paths.push(spec.path) } as any);
    expect(paths).toContain("/cli/priorities/move");
    expect(paths.filter((p) => p.endsWith("/rank"))).toEqual([]);
    expect(Object.keys(priorities).filter((name) => name === "rank" || name === "cliRank")).toEqual([]);
  });
});
