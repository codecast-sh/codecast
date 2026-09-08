import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TRASH_GRACE_MS, moveToTrash, sweepTrash } from "./trash.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-trash-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeTree(name: string): string {
  const tree = path.join(dir, name);
  fs.mkdirSync(path.join(tree, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(tree, "work.txt"), name);
  return tree;
}

test("a trashed worktree leaves its path at once and keeps its contents", () => {
  const tree = makeTree("alpha");
  const trashed = moveToTrash(tree);

  expect(fs.existsSync(tree)).toBe(false);
  expect(path.dirname(trashed)).toBe(dir);
  expect(path.basename(trashed).startsWith("_trash-")).toBe(true);
  expect(fs.readFileSync(path.join(trashed, "work.txt"), "utf8")).toBe("alpha");
  expect(fs.existsSync(path.join(trashed, "node_modules", "pkg"))).toBe(true);
});

test("two destroys in a row do not collide", () => {
  const first = moveToTrash(makeTree("alpha"));
  const second = moveToTrash(makeTree("beta"));
  expect(first).not.toBe(second);
  expect(fs.readdirSync(dir).sort()).toEqual([path.basename(first), path.basename(second)].sort());
});

test("the sweep deletes trash past the grace period and nothing else", async () => {
  const recent = moveToTrash(makeTree("alpha"));
  const old = moveToTrash(makeTree("beta"));
  // A live worktree is never swept, however old its own mtime is.
  const live = makeTree("keep-me-i-am-a-worktree");
  const ancient = new Date(Date.now() - 30 * 24 * 60 * 60_000);
  fs.utimesSync(live, ancient, ancient);

  expect(await sweepTrash(dir)).toEqual([]);

  const past = new Date(Date.now() - TRASH_GRACE_MS - 60_000);
  fs.utimesSync(old, past, past);
  expect(await sweepTrash(dir)).toEqual([old]);

  expect(fs.existsSync(old)).toBe(false);
  expect(fs.existsSync(recent)).toBe(true);
  expect(fs.existsSync(path.join(live, "work.txt"))).toBe(true);
});

test("the sweep is quiet about a directory that does not exist", async () => {
  expect(await sweepTrash(path.join(dir, "nope"))).toEqual([]);
});
