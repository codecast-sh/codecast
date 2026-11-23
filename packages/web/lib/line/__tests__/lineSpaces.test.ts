import { describe, expect, test } from "bun:test";
import { lineSpaces, pickLineSpace } from "../lineSpaces";

const teams = [{ _id: "u1", name: "Union" }, { _id: "c1", name: "Codecast" }, { _id: "f1", name: "Footage" }];
const cause = (workspace: string, status = "open") => ({ cause: {}, status, workspace });

describe("the workspace /line reads", () => {
  // The founder's app sat on Personal (1 open test problem) while his lines ran in Union: /line read Personal and
  // showed nothing waiting on him.
  const tasks = [
    cause("user:me"), cause("user:me", "done"),
    cause("team:u1"), cause("team:u1"), cause("team:u1", "done"),
    cause("team:c1"), cause("team:c1", "done"),
    { status: "open", workspace: "team:f1" },
    cause("team:gone"),
  ];
  const spaces = lineSpaces(tasks, teams, "me");

  test("offers every team of the viewer's, busiest first, then Personal when it holds problems", () => {
    expect(spaces).toEqual([
      { key: "team:u1", name: "Union", open: 2, problems: 3 },
      { key: "team:c1", name: "Codecast", open: 1, problems: 2 },
      // A team with no problems still reads: its pipelines are there (pipeline.md PL6).
      { key: "team:f1", name: "Footage", open: 0, problems: 0 },
      { key: "user:me", name: "Personal", open: 1, problems: 2 },
    ]);
    expect(lineSpaces([], teams, "me").map((s) => s.key)).toEqual(["team:c1", "team:f1", "team:u1"]);
  });

  test("a cached row of a team the viewer is not in is not offered", () => {
    expect(spaces.map((s) => s.key)).not.toContain("team:gone");
  });

  test("the linked thing's workspace wins, then the device's last pick, then the busiest; never the app's active one by default", () => {
    expect(pickLineSpace(spaces, [], null)).toBe("team:u1");
    expect(pickLineSpace(spaces, [], "user:me")).toBe("user:me");
    expect(pickLineSpace(spaces, ["team:c1"], "user:me")).toBe("team:c1");
    // A pick of a quiet team holds; a link naming a workspace the viewer is not in falls through.
    expect(pickLineSpace(spaces, ["team:f1"], "team:gone")).toBe("team:f1");
    expect(pickLineSpace(spaces, ["team:gone"], null)).toBe("team:u1");
    expect(pickLineSpace([], [], null)).toBeNull();
  });
});
