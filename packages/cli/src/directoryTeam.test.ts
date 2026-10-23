import { describe, expect, test } from "bun:test";
import { teamForDirectory } from "./directoryTeam";

describe("the team a directory's work belongs to", () => {
  const projects = [
    { path: "/src/union", team_id: "union" },
    { path: "/src/union/outreach", team_id: "outreach" },
    { path: "/src/codecast", team_id: "codecast" },
    { path: "/src/secret", team_id: "codecast", private: true },
  ];
  test("the longest mapping covering the directory wins", () => {
    expect(teamForDirectory(projects, "/src/union/outreach/backend")).toBe("outreach");
    expect(teamForDirectory(projects, "/src/union/web")).toBe("union");
    expect(teamForDirectory(projects, "/src/codecast")).toBe("codecast");
  });
  test("no mapping, a sibling with a shared prefix, or a locked folder names no team", () => {
    expect(teamForDirectory(projects, "/src/elsewhere")).toBeNull();
    expect(teamForDirectory(projects, "/src/codecast-old")).toBeNull();
    expect(teamForDirectory(projects, "/src/secret/x")).toBeNull();
  });
});
