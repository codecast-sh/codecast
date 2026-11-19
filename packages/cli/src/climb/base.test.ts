// The climb's base (ct-97276): the shared checkout's HEAD lagged origin/main by
// several commits, two env fixes on main were not in the base, and Gauge
// failed the same way three times. The base is the upstream tip, fetched now.
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { baseWords, climbBase } from "./base";

let tmp: string, checkout: string, other: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const commit = (cwd: string, file: string) => { fs.writeFileSync(path.join(cwd, file), file); git(cwd, "add", "-A"); git(cwd, "commit", "-q", "-m", file); return git(cwd, "rev-parse", "HEAD"); };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "climb-base-"));
  git(tmp, "init", "-q", "--bare", "-b", "main", "origin.git");
  checkout = path.join(tmp, "checkout");
  other = path.join(tmp, "other");
  git(tmp, "clone", "-q", "origin.git", "checkout");
  for (const d of [checkout]) { git(d, "config", "user.email", "t@t"); git(d, "config", "user.name", "t"); }
  commit(checkout, "a");
  git(checkout, "push", "-q", "origin", "main");
  git(tmp, "clone", "-q", "origin.git", "other");
  git(other, "config", "user.email", "t@t"); git(other, "config", "user.name", "t");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("a checkout behind its upstream climbs from the upstream tip, fetched now, and the card says how far HEAD lagged", () => {
  // Another session lands two env fixes on main; this shared checkout has not caught up.
  commit(other, "fix1");
  const tip = commit(other, "fix2");
  git(other, "push", "-q", "origin", "main");
  const head = git(checkout, "rev-parse", "HEAD");
  const b = climbBase(checkout)!;
  expect(b.sha).toBe(tip);
  expect(b.sha).not.toBe(head);
  expect([b.from, b.fetched, b.head_behind, b.head_ahead]).toEqual(["origin/main", true, 2, 0]);
  expect(baseWords(b)).toBe(`${tip.slice(0, 10)}, the tip of origin/main, fetched now; this checkout's HEAD was 2 behind`);
});

test("a fetch that fails bases on the last fetched tip and says so; no upstream bases on HEAD and says so; --base is taken as named", () => {
  git(checkout, "remote", "set-url", "origin", path.join(tmp, "gone.git"));
  const failed = climbBase(checkout)!;
  expect([failed.from, failed.fetched]).toEqual(["origin/main", false]);
  expect(failed.note).toContain("fetching origin/main failed");
  const lone = path.join(tmp, "lone");
  fs.mkdirSync(lone);
  git(lone, "init", "-q", "-b", "main"); git(lone, "config", "user.email", "t@t"); git(lone, "config", "user.name", "t");
  const sha = commit(lone, "x");
  expect(climbBase(lone)).toMatchObject({ sha, from: "HEAD", note: "this checkout has no upstream to base on, so the climb bases on its HEAD" });
  expect(climbBase(lone, "HEAD")).toMatchObject({ sha, from: "explicit" });
  expect(climbBase(lone, "nope")).toBeNull();
});
