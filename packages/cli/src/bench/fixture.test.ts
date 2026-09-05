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
