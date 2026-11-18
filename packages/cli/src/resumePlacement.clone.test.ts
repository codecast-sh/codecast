import { expect, test } from "bun:test";
import { cloneDestination } from "./resumePlacement.js";

const repo = { git_root: "/Users/david/git/littlebird", git_remote_url: "git@github.com:littlebirdai/littlebird.git" };

test("a start for a checkout this machine lacks clones it to the same place under this home", () => {
  expect(cloneDestination("/Users/david/git/littlebird", repo, "/Users/rentamac"))
    .toEqual({ root: "/Users/rentamac/git/littlebird", cwd: "/Users/rentamac/git/littlebird" });
  expect(cloneDestination("/Users/david/git/littlebird/backend", repo, "/home/ubuntu"))
    .toEqual({ root: "/home/ubuntu/git/littlebird", cwd: "/home/ubuntu/git/littlebird/backend" });
});

test("a repo outside any home lands at ~/<name>", () => {
  expect(cloneDestination("/opt/src/app", { git_root: "/opt/src/app", git_remote_url: "x" }, "/Users/a"))
    .toEqual({ root: "/Users/a/app", cwd: "/Users/a/app" });
});

test("nothing to clone without a remote, and never into the home folder itself", () => {
  expect(cloneDestination("/Users/david/git/littlebird", { git_root: repo.git_root, git_remote_url: null }, "/Users/r")).toBeNull();
  expect(cloneDestination("/Users/david", { git_root: "/Users/david", git_remote_url: "x" }, "/Users/r")).toBeNull();
  expect(cloneDestination("/Users/david/git/x", repo, undefined)).toBeNull();
});
