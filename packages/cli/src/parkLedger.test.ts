import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ParkLedger } from "./parkLedger.js";

const dirs: string[] = [];
const ledgerFile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "park-ledger-"));
  dirs.push(dir);
  return path.join(dir, "parked-sessions.json");
};
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

test("a park made before a restart is back in the set after it", () => {
  const file = ledgerFile();
  const before = new ParkLedger();
  before.restore(file);
  before.add("s-parked");
  before.add("s-woke");
  before.delete("s-woke");

  const after = new ParkLedger();
  expect(after.restore(file)).toEqual(["s-parked"]);
  expect([...after]).toEqual(["s-parked"]);
});

test("restore skips sessions that came back without the daemon, and drops them from the file", () => {
  const file = ledgerFile();
  fs.writeFileSync(file, JSON.stringify(["live", "parked", 7]));
  const ledger = new ParkLedger();
  expect(ledger.restore(file, (id) => id === "live")).toEqual(["parked"]);
  expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual(["parked"]);
});

test("before restore names a file, and after detach, changes write nothing", () => {
  const file = ledgerFile();
  const ledger = new ParkLedger();
  ledger.add("s1");
  expect(fs.existsSync(file)).toBe(false);
  expect(ledger.has("s1")).toBe(true);

  ledger.restore(file);
  ledger.detach();
  ledger.add("s2");
  expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual(["s1"]);
});

test("a missing or corrupt ledger restores nothing", () => {
  const file = ledgerFile();
  expect(new ParkLedger().restore(file)).toEqual([]);
  fs.writeFileSync(file, "{not json");
  expect(new ParkLedger().restore(file)).toEqual([]);
});
