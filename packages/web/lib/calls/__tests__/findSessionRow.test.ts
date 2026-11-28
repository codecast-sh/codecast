import { expect, test } from "bun:test";
import { findSessionRow } from "../findSessionRow";

const state = { sessions: { c1: { _id: "c1", session_id: "s1", short_id: "jx1" }, c2: { _id: "c2", session_id: "s2" } } };

test("finds a session by conversation id, session id or short id", () => {
  expect(findSessionRow(state, "c1")?._id).toBe("c1");
  expect(findSessionRow(state, "s2")?._id).toBe("c2");
  expect(findSessionRow(state, "jx1")?._id).toBe("c1");
});

test("a joining chip's empty target names no session, not the first one without a short id", () => {
  expect(findSessionRow(state, "")).toBeNull();
});
