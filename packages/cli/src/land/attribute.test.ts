// Which paths a session's shell command wrote (attribute.ts shellWrites). A relative path is the command's own
// directory's: a session in another repository, or in a worktree nested under this checkout, that wrote
// `.codecast/flows/change.cast` wrote its own copy. Before, every checkout's change.cast showed as "also edited by" each
// session that ever wrote one anywhere.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { shellWrites } from "./attribute";

let tmp: string;
let root: string;
let other: string;
const repo = (dir: string) => {
  fs.mkdirSync(path.join(dir, ".codecast", "flows"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".codecast", "flows", "change.cast"), "x");
  spawnSync("git", ["init", "-q", dir]);
};
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "attr-relpaths-")));
  root = path.join(tmp, "app");
  other = path.join(tmp, "acme");
  repo(root);
  repo(other);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const WRITE = "sed -i '' 's/a/b/' .codecast/flows/change.cast";

describe("a shell command's relative paths", () => {
  test("are this checkout's when the command ran in it, from its root or a directory inside it", () => {
    expect(shellWrites(WRITE, root, root)).toEqual([".codecast/flows/change.cast"]);
    fs.mkdirSync(path.join(root, "packages", "cli"), { recursive: true });
    expect(shellWrites(WRITE, path.join(root, "packages", "cli"), root)).toEqual([".codecast/flows/change.cast"]);
  });

  test("are never this checkout's when the command ran in another repository", () => {
    expect(shellWrites(WRITE, other, root)).toEqual([]);
    expect(shellWrites(`cd ${other} && ${WRITE}`, other, root)).toEqual([]);
  });

  test("are the nested worktree's, not this checkout's, when the command ran in a worktree under it", () => {
    const wt = path.join(root, ".conductor", "feat");
    fs.mkdirSync(path.join(wt, ".codecast", "flows"), { recursive: true });
    fs.writeFileSync(path.join(wt, ".git"), "gitdir: elsewhere\n");
    expect(shellWrites("sed -i '' 's/a/b/' .codecast/flows/missing.cast", wt, root)).toEqual([]);
    expect(shellWrites(WRITE, wt, root)).not.toContain(".codecast/flows/change.cast");
  });

  test("an absolute path inside this checkout is its own wherever the command ran", () => {
    expect(shellWrites(`sed -i '' 's/a/b/' ${path.join(root, ".codecast/flows/change.cast")}`, other, root)).toEqual([".codecast/flows/change.cast"]);
  });
});
