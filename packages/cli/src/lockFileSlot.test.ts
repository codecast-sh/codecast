import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileSlot, listFileSlots } from "./lockFile.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slots-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

test("a slot cap admits that many holders and queues the next until one frees", async () => {
  const a = await acquireFileSlot(dir, 2);
  const b = await acquireFileSlot(dir, 2);
  let waited = false;
  let third: (() => void) | null = null;
  const pending = acquireFileSlot(dir, 2, { onWait: () => { waited = true; } }).then((r) => { third = r; });
  await Bun.sleep(300);
  expect(waited).toBe(true);
  expect(third).toBeNull();
  a();
  await pending;
  expect(third).not.toBeNull();
  b();
  third!();
});

test("a slot whose holder died is free again", async () => {
  fs.writeFileSync(path.join(dir, "slot-0.lock"), JSON.stringify({ pid: 999_999, at: Date.now() }));
  const r = await acquireFileSlot(dir, 1, { waitMs: 2_000 });
  r();
});

test("a full cap with a deadline says so", async () => {
  const held = await acquireFileSlot(dir, 1);
  await expect(acquireFileSlot(dir, 1, { waitMs: 100, describe: "test slots" })).rejects.toThrow("all 1 test slots are taken");
  held();
});

test("a listing names what holds each slot and what waits, and forgets a waiter once it starts", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "slots-list-"));
  const held = await acquireFileSlot(d, 1, { what: "cast spawn --cloud a" });
  const pending = acquireFileSlot(d, 1, { what: "cast spawn --cloud b" });
  await Bun.sleep(300);
  const before = listFileSlots(d);
  expect(before.holding.map((e) => e.what)).toEqual(["cast spawn --cloud a"]);
  expect(before.waiting.map((e) => e.what)).toEqual(["cast spawn --cloud b"]);
  held();
  const second = await pending;
  const after = listFileSlots(d);
  expect(after.holding.map((e) => e.what)).toEqual(["cast spawn --cloud b"]);
  expect(after.waiting).toEqual([]);
  second();
  fs.rmSync(d, { recursive: true, force: true });
});
