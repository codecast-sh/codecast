import { describe, expect, test } from "bun:test";
import { listedTeam } from "./directoryTeam";

describe("the team a directory's work belongs to", () => {
  const projects = [
    { path: "/src/acme", team_id: "acme" },
    { path: "/src/acme/server", team_id: "server" },
    { path: "/src/codecast", team_id: "codecast" },
    { path: "/src/secret", team_id: "codecast", private: true },
  ];
  test("the longest mapping covering the directory wins", () => {
    expect(listedTeam(projects, "/src/acme/server/backend")).toBe("server");
    expect(listedTeam(projects, "/src/acme/web")).toBe("acme");
    expect(listedTeam(projects, "/src/codecast")).toBe("codecast");
  });
  test("no mapping, a sibling with a shared prefix, or a locked folder names no team", () => {
    expect(listedTeam(projects, "/src/elsewhere")).toBeNull();
    expect(listedTeam(projects, "/src/codecast-old")).toBeNull();
    expect(listedTeam(projects, "/src/secret/x")).toBeNull();
  });
});
