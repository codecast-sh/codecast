import { expect, test } from "bun:test";
import { mirrorLaptops, repoNameOf } from "./localMirror";

const now = 1_000_000;
const devices = [
  { device_id: "host", is_remote: true, last_seen: now, local_project_roots: ["/home/ubuntu/work/codecast"] },
  { device_id: "old-mac", last_seen: now - 10 * 60_000, local_project_roots: ["/Users/a/src/codecast"] },
  { device_id: "mac", last_seen: now - 1000, local_project_roots: ["/Users/a/src/codecast", "/Users/a/src/codecast/.codecast/worktrees/x", "/Users/a/src/other"] },
  { device_id: "seeder", last_seen: now - 2000, local_project_roots: ["/Users/b/code/codecast"] },
  { device_id: "no-repo", last_seen: now, local_project_roots: ["/Users/c/src/else"] },
];

test("the repo's name comes from the remote url, else the host checkout path", () => {
  expect(repoNameOf("git@github.com:codecast-sh/codecast.git", null)).toBe("codecast");
  expect(repoNameOf(null, "/home/ubuntu/work/codecast/.codecast/worktrees/cloud-1")).toBe("codecast");
});

test("laptops holding the repo, online first, the seeding laptop first among the online, never the host or a worktree root", () => {
  const conv = { git_remote_url: "https://github.com/codecast-sh/codecast", project_path: "/home/ubuntu/work/codecast/.codecast/worktrees/cloud-1", cloud_seed: { device_id: "seeder", laptop_root: "/Users/b/code/codecast" } };
  expect(mirrorLaptops(devices, conv, now, 120_000)).toEqual([
    { device_id: "seeder", root: "/Users/b/code/codecast", online: true },
    { device_id: "mac", root: "/Users/a/src/codecast", online: true },
    { device_id: "old-mac", root: "/Users/a/src/codecast", online: false },
  ]);
});
