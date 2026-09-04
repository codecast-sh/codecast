import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  hookPortFile,
  identityFile,
  loadOrCreateIdentity,
  readIdentity,
  rotateIdentityToken,
  writeHookPort,
  writeIdentity,
} from "./loopbackIdentity.js";
import { readLoopbackIdentity } from "./bench/probes.js";

const dirs: string[] = [];
function tmpConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-identity-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function modeOf(file: string): string {
  return (fs.statSync(file).mode & 0o777).toString(8);
}

describe("loopback identity file", () => {
  test("a fresh config dir mints an identity at 0600", () => {
    const dir = tmpConfigDir();
    const id = loadOrCreateIdentity(dir);
    expect(id.token).toMatch(/^[0-9a-f]{64}$/);
    expect(id.port).toBe(0);
    expect(id.created_at).toBeGreaterThan(0);
    expect(modeOf(identityFile(dir))).toBe("600");
  });

  test("a second load returns the same token and port", () => {
    const dir = tmpConfigDir();
    const first = loadOrCreateIdentity(dir);
    writeIdentity(dir, { ...first, port: 49211 });
    const second = loadOrCreateIdentity(dir);
    expect(second.token).toBe(first.token);
    expect(second.port).toBe(49211);
    expect(second.created_at).toBe(first.created_at);
  });

  test("a junk file mints a fresh identity instead of throwing", () => {
    for (const body of ["not json at all", "{}", '{"port":49211}', '{"token":""}']) {
      const dir = tmpConfigDir();
      fs.writeFileSync(identityFile(dir), body);
      expect(readIdentity(dir)).toBeNull();
      const minted = loadOrCreateIdentity(dir);
      expect(minted.token).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("a non numeric port is read as unassigned, not NaN", () => {
    const dir = tmpConfigDir();
    fs.writeFileSync(identityFile(dir), '{"port":"forty","token":"abc"}');
    expect(readIdentity(dir)).toEqual({ port: 0, token: "abc", created_at: expect.any(Number) });
  });

  // listen() folds an out of range number back into 16 bits rather than
  // refusing it, so 999999 would quietly bind 16959 and every reader would
  // look for the daemon on a port it is not on.
  test("a port outside the unprivileged range is read as unassigned", () => {
    for (const port of [999999, 65536, 80, 1023, -1, 0]) {
      const dir = tmpConfigDir();
      fs.writeFileSync(identityFile(dir), JSON.stringify({ port, token: "abc" }));
      expect(readIdentity(dir)!.port).toBe(0);
      expect(readIdentity(dir)!.token).toBe("abc");
    }
  });

  // A torn write reads as junk, and junk mints a new token and port, which is
  // the loss this file exists to prevent. atomicWriteFile publishes by rename,
  // so a reader sees the whole old file or the whole new one.
  test("a write publishes whole, never over the live file", () => {
    const dir = tmpConfigDir();
    const before = loadOrCreateIdentity(dir);
    const temps = () => fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    writeIdentity(dir, { ...before, port: 49216 });
    expect(temps()).toEqual([]);
    expect(readIdentity(dir)).toMatchObject({ port: 49216, token: before.token });
  });

  test("a file written before created_at existed still loads and keeps its token", () => {
    const dir = tmpConfigDir();
    // The exact shape today's daemon writes.
    fs.writeFileSync(identityFile(dir), JSON.stringify({ port: 49212, token: "deadbeef", pid: 4242 }));
    const id = loadOrCreateIdentity(dir);
    expect(id.token).toBe("deadbeef");
    expect(id.port).toBe(49212);
    expect(id.pid).toBe(4242);
    expect(id.created_at).toBeGreaterThan(0);
  });

  test("rotate changes the token, keeps the port and the birthday, stays 0600", () => {
    const dir = tmpConfigDir();
    const before = loadOrCreateIdentity(dir);
    writeIdentity(dir, { ...before, port: 49213, pid: 99 });
    const after = rotateIdentityToken(dir);
    expect(after.token).not.toBe(before.token);
    expect(after.token).toMatch(/^[0-9a-f]{64}$/);
    expect(after.port).toBe(49213);
    expect(after.created_at).toBe(before.created_at);
    expect(modeOf(identityFile(dir))).toBe("600");
    expect(readIdentity(dir)!.token).toBe(after.token);
  });

  test("a rewrite of an existing 0644 file ends at 0600", () => {
    const dir = tmpConfigDir();
    fs.writeFileSync(identityFile(dir), "{}", { mode: 0o644 });
    writeIdentity(dir, { port: 1, token: "t", created_at: 1 });
    expect(modeOf(identityFile(dir))).toBe("600");
  });

  test("hook-port is written at 0600", () => {
    const dir = tmpConfigDir();
    writeHookPort(dir, 49214);
    expect(fs.readFileSync(hookPortFile(dir), "utf-8")).toBe("49214");
    expect(modeOf(hookPortFile(dir))).toBe("600");
  });

  // The bench reads both files on every run. If the format drifts, `cast bench
  // daemon` silently loses its authenticated routes, so the contract is a test.
  test("the bench's reader accepts what we write", () => {
    const dir = tmpConfigDir();
    const id = { port: 49215, token: "a".repeat(64), created_at: Date.now(), pid: process.pid };
    writeIdentity(dir, id);
    writeHookPort(dir, id.port);
    expect(readLoopbackIdentity(dir)).toEqual({ port: 49215, token: id.token, reason: null });
  });
});
