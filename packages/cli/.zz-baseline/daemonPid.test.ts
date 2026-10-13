import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDaemonPid } from "./daemonPid.js";

const dir = mkdtempSync(join(tmpdir(), "daemon-pid-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.each(["EPERM", "EACCES"])("a %s probe preserves the live daemon and its pid file", code => {
  const file = join(dir, code);
  writeFileSync(file, "1234");
  let fallbacks = 0;
  expect(readDaemonPid(file, () => { fallbacks++; return null; }, () => {
    throw Object.assign(new Error(code), { code });
  })).toBe(1234);
  expect(readFileSync(file, "utf8")).toBe("1234");
  expect(fallbacks).toBe(0);
});

test("a missing process falls back without mutating a pid file owned by the supervisor", () => {
  const file = join(dir, "stale");
  writeFileSync(file, "1234");
  expect(readDaemonPid(file, () => 5678, () => {
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  })).toBe(5678);
  expect(readFileSync(file, "utf8")).toBe("1234");
});

test.each(["", "0", "-1", "12garbage", "NaN"])("invalid pid %j cannot target a process group", contents => {
  const file = join(dir, "invalid");
  writeFileSync(file, contents);
  expect(readDaemonPid(file, () => null, () => { throw new Error("must not probe"); })).toBeNull();
});

test("a real process is detected", () => {
  const file = join(dir, "live");
  writeFileSync(file, String(process.pid));
  expect(readDaemonPid(file, () => null)).toBe(process.pid);
});

test("unexpected probe failures propagate without deleting the pid file", () => {
  const file = join(dir, "unexpected");
  writeFileSync(file, "1234");
  expect(() => readDaemonPid(file, () => null, () => { throw new Error("unexpected"); })).toThrow("unexpected");
  expect(readFileSync(file, "utf8")).toBe("1234");
});
