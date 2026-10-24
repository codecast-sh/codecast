import { describe, expect, test } from "bun:test";
import { formatTeamHostMarker, parseTeamHostMarker, pickLinuxUser } from "./teamHosts";

describe("pickLinuxUser", () => {
  test("GitHub login first, then the email's name, lowercased into a valid login", () => {
    expect(pickLinuxUser({ github: "JasonBenn" }, [])).toBe("jasonbenn");
    expect(pickLinuxUser({ email: "Cam.Smith@union.ai" }, [])).toBe("camsmith");
    expect(pickLinuxUser({ name: "42 Samvit R" }, [])).toBe("member");
  });

  test("a taken or reserved name gets a number; a valid free request wins", () => {
    expect(pickLinuxUser({ github: "ashot" }, ["ashot"])).toBe("ashot2");
    expect(pickLinuxUser({ github: "ubuntu" }, [])).toBe("ubuntu2");
    expect(pickLinuxUser({ requested: "ap", github: "ashot" }, [])).toBe("ap");
    expect(pickLinuxUser({ requested: "Bad Name", github: "ashot" }, [])).toBe("ashot");
  });
});

describe("the team machine marker", () => {
  test("round-trips, and an empty or foreign marker parses to nothing", () => {
    const m = { key: "ab".repeat(24), admin: "ubuntu", team: "jd7abc" };
    expect(parseTeamHostMarker(formatTeamHostMarker(m))).toEqual(m);
    expect(parseTeamHostMarker("")).toEqual({});
    expect(parseTeamHostMarker("key=$(rm -rf /)\nadmin=root user")).toEqual({});
  });
});
