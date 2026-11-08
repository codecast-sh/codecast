import { describe, expect, test } from "bun:test";
import { listTasks } from "./taskPages";

function backend(listError?: string) {
  const calls: string[] = [];
  const post = async (path: string, body: Record<string, any>) => {
    calls.push(path);
    if (path === "/cli/work/list") {
      if (listError) throw new Error(listError);
      return [{ short_id: "ct-1" }];
    }
    return body.cursor ? { tasks: [{ short_id: "ct-3" }], cursor: null } : { tasks: [{ short_id: "ct-2" }], cursor: "next" };
  };
  return { post, calls };
}

describe("listTasks", () => {
  test("the whole board (--all) reads pages, bounded on any team", async () => {
    const { post, calls } = backend();
    expect((await listTasks(post, { limit: 50, include_done: true })).map((t) => t.short_id)).toEqual(["ct-2", "ct-3"]);
    expect(calls).toEqual(["/cli/work/page", "/cli/work/page"]);
  });

  // Pages walk done work too, so a short open list would read the whole history.
  test("a plain listing asks the list route's open-status ranges", async () => {
    const { post, calls } = backend();
    expect(await listTasks(post, { limit: 50 })).toEqual([{ short_id: "ct-1" }]);
    expect(calls).toEqual(["/cli/work/list"]);
  });

  test("a plain listing that runs the server out of memory walks pages instead", async () => {
    const { post, calls } = backend("Too many bytes read in a single function execution");
    expect((await listTasks(post, { limit: 50 })).map((t) => t.short_id)).toEqual(["ct-2", "ct-3"]);
    expect(calls).toEqual(["/cli/work/list", "/cli/work/page", "/cli/work/page"]);
  });

  test("a search asks the list route, which answers from the search index", async () => {
    const { post, calls } = backend();
    expect(await listTasks(post, { limit: 50, query: "deploy" })).toEqual([{ short_id: "ct-1" }]);
    expect(calls).toEqual(["/cli/work/list"]);
  });

  test("a search against a backend that runs out of memory walks pages instead", async () => {
    const { post, calls } = backend("JavaScript execution ran out of memory (maximum memory usage: 64 MB)");
    expect((await listTasks(post, { limit: 50, query: "deploy" })).map((t) => t.short_id)).toEqual(["ct-2", "ct-3"]);
    expect(calls[0]).toBe("/cli/work/list");
  });

  test("any other error stays an error", async () => {
    const { post } = backend("Unauthorized");
    await expect(listTasks(post, { limit: 50, query: "deploy" })).rejects.toThrow("Unauthorized");
  });

  test("the frontier and index-served filters keep the list route", async () => {
    const { post, calls } = backend();
    await listTasks(post, { limit: 50, ready: true });
    await listTasks(post, { limit: 50, assignee: "me" });
    expect(calls).toEqual(["/cli/work/list", "/cli/work/list"]);
  });
});
