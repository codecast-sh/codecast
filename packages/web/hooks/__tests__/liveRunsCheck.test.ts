import { describe, expect, test } from "bun:test";
import { staleLiveRuns } from "../useLiveRunsCheck";

// Real-shaped ids: the walk skips rows whose ids the server could never know (fixtures, stubs).
const id = (n: number) => `th7${String(n).padStart(29, "a")}`;
const T = "team:k97union";

describe("the runs the store holds as live that the server does not", () => {
  const runs = {
    [id(1)]: { _id: id(1), status: "paused", workspace: T },
    [id(2)]: { _id: id(2), status: "running", workspace: T },
    [id(3)]: { _id: id(3), status: "failed", workspace: T },
    [id(4)]: { _id: id(4), status: "running", workspace: "team:other" },
    galleryflowrunlive000001: { _id: "galleryflowrunlive000001", status: "running", workspace: T },
  };

  test("a live row the answer does not name is stale; a named one, an ended one, another workspace's and a made-up id are not", () => {
    expect(staleLiveRuns(runs, { workspaces: [T], ids: [id(2)], complete: true })).toEqual([id(1)]);
  });

  test("a capped answer cannot say which rows ended, so it names none", () => {
    expect(staleLiveRuns(runs, { workspaces: [T], ids: [], complete: false })).toEqual([]);
  });

  test("at most one byIds answer's worth at a time", () => {
    expect(staleLiveRuns(runs, { workspaces: [T], ids: [], complete: true }, 1)).toHaveLength(1);
  });
});
