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

  test("offers each of the viewer's workspaces holding problems, busiest first, by name", () => {
    expect(spaces).toEqual([
      { key: "team:u1", name: "Union", open: 2, problems: 3 },
      { key: "team:c1", name: "Codecast", open: 1, problems: 2 },
      { key: "user:me", name: "Personal", open: 1, problems: 2 },
    ]);
  });

  test("a team without problems, and a cached row of a team the viewer is not in, are not offered", () => {
    expect(spaces.map((s) => s.key)).not.toContain("team:f1");
    expect(spaces.map((s) => s.key)).not.toContain("team:gone");
  });

  test("the linked thing's workspace wins, then the device's last pick, then the busiest; never the app's active one by default", () => {
    expect(pickLineSpace(spaces, [], null)).toBe("team:u1");
    expect(pickLineSpace(spaces, [], "user:me")).toBe("user:me");
    expect(pickLineSpace(spaces, ["team:c1"], "user:me")).toBe("team:c1");
    // A pick or link naming a workspace that holds no problems falls through.
    expect(pickLineSpace(spaces, ["team:f1"], "team:gone")).toBe("team:u1");
    expect(pickLineSpace([], [], null)).toBeNull();
  });
});
