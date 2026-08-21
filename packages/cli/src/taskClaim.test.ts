import { describe, expect, test } from "bun:test";
import { buildTaskStartBody } from "./taskClaim.js";

describe("buildTaskStartBody", () => {
  test("a human shell claims by assignee, with no session binding", () => {
    expect(buildTaskStartBody("ct-1", null)).toEqual({ short_id: "ct-1", status: "in_progress", assignee: "me" });
  });

  test("an agent session claims by session binding and never self-assigns the owner", () => {
    const body = buildTaskStartBody("ct-1", "sess-1");
    expect(body).toEqual({ short_id: "ct-1", status: "in_progress", conversation_id: "sess-1" });
    expect("assignee" in body).toBe(false);
  });
});
