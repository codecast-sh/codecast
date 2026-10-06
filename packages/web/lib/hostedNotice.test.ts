import { describe, expect, test } from "bun:test";
import { foldHostedRetries, type RetryFoldRow } from "./hostedNotice";

const ask = (id: string, text = "keep basil alive on a windowsill?"): RetryFoldRow => ({ _id: id, role: "user", content: text, person: true });
const fail = (id: string): RetryFoldRow => ({ _id: id, role: "assistant", subtype: "notice:error", content: "I can't reach my thinking service.", message_uuid: `notice:${id}` });
const reply = (id: string): RetryFoldRow => ({ _id: id, role: "assistant", content: "Water it when the top inch is dry." });

describe("foldHostedRetries", () => {
  test("Try again folds the first notice and the repeated ask, and counts two attempts", () => {
    // The rows conversation jx7bj3h5 stored: ask, notice, the same ask (a new
    // client id), notice. Both notices used to show.
    const { hidden, attempts } = foldHostedRetries([ask("u1"), fail("n1"), ask("u2"), fail("n2")]);
    expect([...hidden].sort()).toEqual(["n1", "u2"]);
    expect(attempts.get("n2")).toBe(2);
  });

  test("two notices in a row (the engine retried) show as one", () => {
    const { hidden, attempts } = foldHostedRetries([ask("u1"), fail("n1"), fail("n2")]);
    expect([...hidden]).toEqual(["n1"]);
    expect(attempts.get("n2")).toBe(2);
  });

  test("a retry that succeeds leaves the ask and the reply", () => {
    const { hidden } = foldHostedRetries([ask("u1"), fail("n1"), ask("u2"), reply("a1")]);
    expect([...hidden].sort()).toEqual(["n1", "u2"]);
  });

  test("a different request after a stop starts a new turn", () => {
    const { hidden, attempts } = foldHostedRetries([ask("u1"), fail("n1"), ask("u2", "something else"), fail("n2")]);
    expect(hidden.size).toBe(0);
    expect(attempts.get("n2")).toBe(1);
  });

  test("rows that are not the person's words are passed over", () => {
    const tool: RetryFoldRow = { _id: "t1", role: "user", content: "keep basil alive on a windowsill?", person: false };
    const { hidden } = foldHostedRetries([ask("u1"), fail("n1"), tool, ask("u2"), fail("n2")]);
    expect([...hidden].sort()).toEqual(["n1", "u2"]);
  });
});
