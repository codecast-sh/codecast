import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearThreadStatePulse, threadStateCounterPath, threadStateTurnPath, writeThreadStatePulse } from "./threadStateStamp.js";

// Every `cast state` write starts the hook over: the message baseline and the
// marker that the pinning turn has ended both go, so the turn that wrote the
// pin is never held for not pinning (threadStateHook.ts).
let dir: string;
const saved = process.env.CODECAST_DIR;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-stamp-"));
  process.env.CODECAST_DIR = dir;
});

afterAll(() => {
  if (saved === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

const marks = (id: string) => [threadStateCounterPath(id), threadStateTurnPath(id)];
const lay = (id: string) => {
  for (const mark of marks(id)) {
    fs.mkdirSync(path.dirname(mark), { recursive: true });
    fs.writeFileSync(mark, "1");
  }
};

test("a write drops the baseline and the turn marker", () => {
  lay("s1");
  writeThreadStatePulse("s1", "dormant");
  expect(marks("s1").map((m) => fs.existsSync(m))).toEqual([false, false]);
});

test("a clear drops them too", () => {
  lay("s2");
  clearThreadStatePulse("s2");
  expect(marks("s2").map((m) => fs.existsSync(m))).toEqual([false, false]);
});
