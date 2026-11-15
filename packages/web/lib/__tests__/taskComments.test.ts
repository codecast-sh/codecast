import { describe, expect, test } from "bun:test";
import { taskCommentCount, taskCommentsOf, withoutListThread } from "../taskComments";

const c = (id: string, at: number) => ({ _id: id, text: id, created_at: at });

describe("taskComments", () => {
  test("the count is the server's, or the held thread when it holds more", () => {
    expect(taskCommentCount({ comment_count: 7 })).toBe(7);
    expect(taskCommentCount({ comments: [c("a", 1), c("b", 2)] })).toBe(2);
    expect(taskCommentCount({ comment_count: 1, comments: [c("a", 1), c("b", 2)] })).toBe(2);
    expect(taskCommentCount(null)).toBe(0);
  });

  test("the comments are the thread with the list's newest over it, oldest first", () => {
    const thread = [c("a", 1), c("b", 2)];
    expect(taskCommentsOf({ comments: thread })).toBe(thread);
    const recent = [c("b", 2), c("z", 9)];
    expect(taskCommentsOf({ recent_comments: recent })).toBe(recent);
    const row = { comments: thread, recent_comments: recent };
    const both = taskCommentsOf(row);
    expect(both.map((x) => x._id)).toEqual(["a", "b", "z"]);
    expect(taskCommentsOf(row)).toBe(both);
  });

  test("only a count-carrying row loses its held thread", () => {
    const counted = { comment_count: 2, comments: [c("a", 1)], title: "t" };
    expect(withoutListThread(counted)).toEqual({ comment_count: 2, title: "t" });
    const old = { comments: [c("a", 1)] };
    expect(withoutListThread(old)).toBe(old);
  });
});
