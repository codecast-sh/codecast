import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearForeignProfileLock } from "./instance.js";

function profileLockedBy(target: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-profile-lock-"));
  fs.symlinkSync(target, path.join(dir, "SingletonLock"));
  fs.symlinkSync("123", path.join(dir, "SingletonCookie"));
  fs.symlinkSync("/tmp/x/SingletonSocket", path.join(dir, "SingletonSocket"));
  return dir;
}

test("a lock left by the machine a host's disk image was taken on is cleared", () => {
  const dir = profileLockedBy("ip-172-31-44-248-1077836");
  expect(clearForeignProfileLock(dir, "ip-172-31-9-9")).toBe(true);
  expect(fs.readdirSync(dir)).toEqual([]);
});

test("a lock naming this machine is Chrome's to judge", () => {
  const dir = profileLockedBy("ip-172-31-9-9-4242");
  expect(clearForeignProfileLock(dir, "ip-172-31-9-9")).toBe(false);
  expect(fs.readdirSync(dir).sort()).toEqual(["SingletonCookie", "SingletonLock", "SingletonSocket"]);
});

test("no lock, nothing to do", () => {
  expect(clearForeignProfileLock(fs.mkdtempSync(path.join(os.tmpdir(), "cast-profile-lock-")))).toBe(false);
});
