// Feeders scoped to one entity skip until the entity has a Convex id.
// Sentry JAVASCRIPT-REACT-1Q/5Z/60/5T/5S/5R/61/5X (2026-09-15..22): an
// optimistic stub or a daemon uuid on the conversation route reached
// `v.id("conversations")` validators and reported ArgumentValidationError for
// every open transcript.
import { test, expect, describe } from "bun:test";
import { entityIdArgs } from "../useSyncCollection";

describe("entityIdArgs", () => {
  test("a Convex id becomes the query args", () => {
    expect(entityIdArgs("conversation_id", "jx7edd00y85v1rgj5tda5s9cm98ewywv")).toEqual({
      conversation_id: "jx7edd00y85v1rgj5tda5s9cm98ewywv",
    });
  });

  test.each([
    ["a daemon session uuid", "ede6592d-acce-4fd2-8b03-1b704450825b"],
    ["an optimistic session stub", "x29jl6e12ekwaoi1oiu22"],
    ["an optimistic task stub", "temp_task_mu8oomiwpxbaxm"],
    ["no id", undefined],
    ["an empty id", ""],
  ])("%s skips the query", (_label, id) => {
    expect(entityIdArgs("task_id", id)).toBe("skip");
  });
});
