import { describe, expect, test } from "bun:test";
import { threadsMissingReplies } from "./threadPrefetch";

const summary = (root: string, count: number, lastAt: number) =>
  ({ _id: root, root_id: root, reply_count: count, last_reply_at: lastAt, reply_user_ids: [] }) as any;
const reply = (id: string, root: string, at: number) =>
  ({ _id: id, thread_root_id: root, created_at: at, content: "" }) as any;

describe("threadsMissingReplies", () => {
  test("a root whose replies the store holds in full is not wanted", () => {
    const summaries = { a: summary("a", 2, 20) };
    const messages = { r1: reply("r1", "a", 10), r2: reply("r2", "a", 20) };
    expect(threadsMissingReplies(["a"], summaries, messages)).toEqual([]);
  });

  test("a root with none, fewer, or older replies held is wanted", () => {
    const summaries = { none: summary("none", 1, 5), fewer: summary("fewer", 3, 30), older: summary("older", 1, 50) };
    const messages = { f1: reply("f1", "fewer", 30), o1: reply("o1", "older", 40) };
    expect(threadsMissingReplies(["none", "fewer", "older"], summaries, messages)).toEqual(["none", "fewer", "older"]);
  });

  test("a message with no replies, or no rollup, is never fetched", () => {
    expect(threadsMissingReplies(["x", "y"], { x: summary("x", 0, 0) }, {})).toEqual([]);
  });
});
