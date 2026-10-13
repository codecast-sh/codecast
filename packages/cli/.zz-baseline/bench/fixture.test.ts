import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BenchFixture } from "./fixture.js";
import { loadDeps } from "./testFixtures.js";

for (const key of ["jsonlPath", "registryPath", "statusPath"] as const) test(`unacquired ${key} is retained when its pane is absent`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bench-unacquired-"));
  const fixture = new BenchFixture("bench-unacquired", loadDeps.config, root, { socket: path.join(root, "absent.sock") });
  fixture.projectDir = root;
  const row = fixture.allocate();
  try {
    await fs.mkdir(path.dirname(row[key]), { recursive: true });
    await fs.writeFile(row[key], "unknown content\n", { flag: "wx" });
    const before = await fs.lstat(row[key]);
    await expect(fixture.cleanup(row, new AbortController().signal)).rejects.toThrow("unacquired fixture path");
    expect(await fs.readFile(row[key], "utf8")).toBe("unknown content\n");
    expect((await fs.lstat(row[key])).ino).toBe(before.ino);
  } finally { await fs.rm(root, { recursive: true }); }
});

test("unacquired empty allocation needs no destructive cleanup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bench-unacquired-"));
  const fixture = new BenchFixture("bench-unacquired", loadDeps.config, root, { socket: path.join(root, "absent.sock") });
  fixture.projectDir = root;
  try { await fixture.cleanup(fixture.allocate(), new AbortController().signal); expect(await fs.readdir(root)).toEqual([]); }
  finally { await fs.rm(root, { recursive: true }); }
});

for (const name of ["stub.cjs", "fixture-ledger.json"]) test(`finish preserves a replaced ${name} after its earlier checks`, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bench-finish-")));
  let replaced = "";
  const fixture = new BenchFixture(`bench-${crypto.randomUUID()}`, loadDeps.config, root, { home: root, projectDir: root, socket: path.join(root, "absent.sock"), beforeRemove: async file => {
    if (path.basename(file) !== name || replaced) return;
    replaced = file; await fs.rename(file, `${file}.acquired`); await fs.writeFile(file, "unknown successor\n", { flag: "wx" });
  } });
  try {
    await fixture.prepare(new AbortController().signal);
    await expect(fixture.finish()).rejects.toThrow("removal identity changed");
    expect(await fs.readFile(replaced, "utf8")).toBe("unknown successor\n");
    await fs.unlink(replaced); await fs.rename(`${replaced}.acquired`, replaced);
    await fixture.finish();
    expect(await fs.stat(fixture.scratch).then(() => true, () => false)).toBe(false);
  } finally { await fs.rm(root, { recursive: true }); }
});

for (const kind of ["directory", "symlink", "file"]) test(`project custody preserves a ${kind} successor after an awaited removal boundary`, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bench-project-custody-")));
  let replaced = false;
  const fixture = new BenchFixture(`bench-${crypto.randomUUID()}`, loadDeps.config, root, { home: root, projectDir: root, socket: path.join(root, "absent.sock"), beforeRemove: async file => {
    if (file !== fixture.projectDir || replaced) return;
    replaced = true;
    await fs.rename(file, `${file}.acquired`);
    if (kind === "directory") await fs.mkdir(file);
    else if (kind === "symlink") await fs.symlink(`${file}.acquired`, file);
    else await fs.writeFile(file, "unknown successor", { flag: "wx" });
  } });
  try {
    await fixture.prepare(new AbortController().signal);
    const original = await fs.lstat(fixture.projectDir);
    await expect(fixture.finish()).rejects.toThrow("directory ownership changed");
    const successor = await fs.lstat(fixture.projectDir);
    expect(replaced).toBe(true); expect(successor.ino).not.toBe(original.ino);
    expect(successor.isDirectory()).toBe(kind === "directory"); expect(successor.isSymbolicLink()).toBe(kind === "symlink");
    await expect(fixture.finish()).rejects.toThrow("directory ownership changed");
    const retained = await fs.lstat(fixture.projectDir);
    expect([retained.dev, retained.ino]).toEqual([successor.dev, successor.ino]);
    if (kind === "directory") await fs.rmdir(fixture.projectDir); else await fs.unlink(fixture.projectDir);
    await fs.rename(`${fixture.projectDir}.acquired`, fixture.projectDir);
    await fixture.finish();
    expect(await fs.lstat(fixture.scratch).then(() => true, () => false)).toBe(false);
  } finally { await fs.rm(root, { recursive: true }); }
});

test("project custody accepts positively absent acquired directory and retains an unacquired directory", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bench-project-absence-")));
  const fixture = new BenchFixture(`bench-${crypto.randomUUID()}`, loadDeps.config, root, { home: root, projectDir: root, socket: path.join(root, "absent.sock") });
  try {
    fixture.projectDir = root;
    const unknown = await fs.lstat(root);
    await fixture.finish();
    expect((await fs.lstat(root)).ino).toBe(unknown.ino);
    await fixture.prepare(new AbortController().signal);
    await fs.rmdir(fixture.projectDir);
    await fixture.finish();
    expect(await fs.lstat(fixture.scratch).then(() => true, () => false)).toBe(false);
  } finally { await fs.rm(root, { recursive: true }); }
});

for (const boundary of ["entry", "project", "fixture-ledger.json", "stub.cjs", "scratch"]) test(`finish cancellation preserves its ${boundary} removal boundary`, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bench-finish-cancel-")));
  const abort = new AbortController(); let target = "", triggered = false;
  const fixture = new BenchFixture(`bench-${crypto.randomUUID()}`, loadDeps.config, root, { home: root, projectDir: root, socket: path.join(root, "absent.sock"), beforeRemove: async file => {
    if (file !== target || triggered) return;
    await Promise.resolve(); triggered = true; abort.abort(new Error("cancel finish boundary"));
  } });
  try {
    await fixture.prepare(new AbortController().signal);
    target = boundary === "project" ? fixture.projectDir : boundary === "entry" || boundary === "scratch" ? fixture.scratch : path.join(fixture.scratch, boundary);
    const before = await fs.lstat(target);
    if (boundary === "entry") { triggered = true; abort.abort(new Error("cancel finish boundary")); }
    await expect(fixture.finish(abort.signal)).rejects.toThrow("cancel finish boundary");
    expect(triggered).toBe(true);
    const after = await fs.lstat(target);
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    if (boundary === "entry") expect((await fs.readdir(fixture.scratch)).sort()).toEqual(["fixture-ledger.json", "stub.cjs"]);
    await fixture.finish();
    expect(await fs.lstat(fixture.scratch).then(() => true, () => false)).toBe(false);
  } finally { await fs.rm(root, { recursive: true }); }
});
