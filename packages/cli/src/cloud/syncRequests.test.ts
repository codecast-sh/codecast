import { describe, expect, test } from "bun:test";
import { mapPath } from "./syncRequests";
import { requestPath } from "./syncCli";

const where = { localRoot: "/Users/me/src/app", remoteCwd: "/home/ubuntu/work/app/.codecast/worktrees/cloud-1", home: "/Users/me", hostHome: "/home/ubuntu" };

describe("where a pulled path lands", () => {
  test("repo paths map between the laptop checkout and the cloud folder", () => {
    expect(mapPath("packages/web/.env.local", where)).toMatchObject({ from: "/Users/me/src/app/packages/web/.env.local", to: "/home/ubuntu/work/app/.codecast/worktrees/cloud-1/packages/web/.env.local", outside: false });
    expect(mapPath("/Users/me/src/app/assets/", where)).toMatchObject({ rel: "assets", outside: false });
  });

  test("home paths outside the repo land in the host's home", () => {
    expect(mapPath("~/data/export.csv", where)).toMatchObject({ from: "/Users/me/data/export.csv", to: "/home/ubuntu/data/export.csv", outside: true });
    expect(mapPath("/Users/me/.config/tool/x.json", where)).toMatchObject({ to: "/home/ubuntu/.config/tool/x.json", outside: true });
  });

  test("a path that leaves its folder or the home is refused by name", () => {
    expect(() => mapPath("../other/secret", where)).toThrow("leaves the folder");
    expect(() => mapPath("/etc/passwd", where)).toThrow("outside your home folder");
    expect(() => mapPath("~", where)).toThrow("leaves the folder");
  });
});

describe("a path as the asking shell names it", () => {
  const host = { cwd: "/home/ubuntu/work/app/.codecast/worktrees/cloud-1/packages/web", repoRoot: "/home/ubuntu/work/app/.codecast/worktrees/cloud-1", home: "/home/ubuntu" };
  test("relative to where it runs becomes relative to the repo", () => {
    expect(requestPath(".env.local", host)).toBe("packages/web/.env.local");
    expect(requestPath("../../README.md", host)).toBe("README.md");
  });
  test("home paths stay home paths, on either machine", () => {
    expect(requestPath("~/data/x.csv", host)).toBe("~/data/x.csv");
    expect(requestPath("/home/ubuntu/data/x.csv", host)).toBe("~/data/x.csv");
  });
  test("a laptop path named from the host passes through for the laptop to read", () => {
    expect(requestPath("/Users/me/data/x.csv", host)).toBe("/Users/me/data/x.csv");
  });
});
