import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TouchLedger, ledgerUnchanged, signLedger, statSignature } from "./ledger";

let dir: string;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mirror-ledger-"))); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const later = (file: string) => { const t = new Date(Date.now() + 5_000); fs.utimesSync(file, t, t); };

test("a signed ledger holds until a file is edited, added under a listed directory, or removed", async () => {
  const skills = path.join(dir, ".claude/skills");
  const skill = path.join(skills, "a/SKILL.md");
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, "one");
  const touched = new TouchLedger();
  for (const p of [dir, skills, path.dirname(skill), skill, path.join(dir, "absent")]) touched.note(p);
  touched.note(skill);
  expect(touched.paths.size).toBe(5);

  const ledger = await signLedger(touched.paths);
  expect(ledger.get(path.join(dir, "absent"))).toBe("missing");
  expect(ledger.get(skill)).toMatch(/^f:/);
  expect(ledger.get(skills)).toMatch(/^d:/);
  expect(await ledgerUnchanged(ledger)).toBe(true);

  fs.writeFileSync(skill, "two");
  later(skill);
  expect(await ledgerUnchanged(ledger)).toBe(false);

  const again = await signLedger(touched.paths);
  fs.mkdirSync(path.join(skills, "b"));
  later(skills);
  expect(await ledgerUnchanged(again)).toBe(false);

  const third = await signLedger(touched.paths);
  fs.writeFileSync(path.join(dir, "absent"), "now present");
  expect(await ledgerUnchanged(third)).toBe(false);

  const fourth = await signLedger(touched.paths);
  fs.rmSync(skill);
  expect(await ledgerUnchanged(fourth)).toBe(false);
});

test("signatures carry the inode, mode and mtime, and size for files only", () => {
  const file = path.join(dir, "f");
  fs.writeFileSync(file, "abc");
  const st = fs.lstatSync(file);
  expect(statSignature(st)).toBe(`f:${st.ino}:${st.mode}:${Math.floor(st.mtimeMs)}:3`);
  const ds = fs.lstatSync(dir);
  expect(statSignature(ds)).toBe(`d:${ds.ino}:${ds.mode}:${Math.floor(ds.mtimeMs)}`);
  expect(statSignature(null)).toBe("missing");
});
