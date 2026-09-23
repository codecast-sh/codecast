import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { currentTranscriptDeadline, withTranscriptDeadline } from "./workers/ingestDeadline.js";
import { ShellChangeSync } from "./shellChangeSync.js";
import { parseShellChangesFile, readShellChangeBatch, SHELL_CHANGE_BATCH_BYTES } from "./shellChanges.js";

const roots: string[] = [];
const workers: ShellChangeSync[] = [];
afterEach(() => {
  for (const worker of workers.splice(0)) worker.stop();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup(count = 20, content = "x".repeat(180_000), version = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shell-sync-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  const dir = path.join(root, "changes");
  fs.mkdirSync(repo); fs.mkdirSync(dir);
  execFileSync("git", ["-C", repo, "init", "-q"]);
  const hash = execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { input: content, encoding: "utf8" }).trim();
  expect(hash).toMatch(/^[0-9a-f]{40}$/);
  const file = path.join(dir, "toolu_x");
  fs.writeFileSync(file, `root\t${repo}\t${version}\n` + Array.from({ length: count }, (_, n) => `0\t${hash}\tf${String(n).padStart(4, "0")}.ts\n`).join(""));
  expect(parseShellChangesFile(fs.readFileSync(file, "utf8"))?.entries).toHaveLength(count);
  return { root, repo, dir, file };
}

function worker(upload: ConstructorParameters<typeof ShellChangeSync>[0], dir: string) {
  const result = new ShellChangeSync(upload, { dir, initialDelayMs: 10 });
  workers.push(result);
  return result;
}

test("large valid diffs use bounded requests with stable sequence numbers", async () => {
  const { dir, file } = setup();
  const sent: any[] = [];
  const uploader = worker(async (params) => { sent.push(params); }, dir);
  uploader.enqueue("conv", "uuid", [{ toolUseId: "toolu_x" }]);
  uploader.enqueue("conv", "uuid", [{ toolUseId: "toolu_x" }]);
  expect(fs.statSync(path.join(dir, "uploads.json")).size).toBeLessThan(1000);
  expect(await uploader.waitForCompletion(10_000)).toBe(true);
  expect(sent).toHaveLength(5);
  expect(sent.every((p) => Buffer.byteLength(JSON.stringify(p.changes)) <= SHELL_CHANGE_BATCH_BYTES)).toBe(true);
  expect(sent.flatMap((p) => p.changes.map((c: any) => c.seq))).toEqual(Array.from({ length: 20 }, (_, n) => n));
  expect(fs.existsSync(file)).toBe(false);
}, 15_000);

test("a restart recovers a durable shell reference and keeps files until the upload succeeds", async () => {
  const { dir, file } = setup(1, "small");
  const first = worker(async () => { throw new Error("offline"); }, dir);
  first.enqueue("conv", "uuid", [{ toolUseId: "toolu_x" }]);
  first.stop();
  expect(fs.existsSync(file)).toBe(true);
  const sent: unknown[] = [];
  const second = worker(async (params) => { sent.push(params); }, dir);
  expect(await second.waitForCompletion(5000)).toBe(true);
  expect(sent).toHaveLength(1);
  expect(fs.existsSync(file)).toBe(false);
}, 10_000);

test("unverified legacy bulk capture is preserved without loading git blobs or uploading it", async () => {
  const { dir, file, repo } = setup(743, "old", 1);
  fs.rmSync(repo, { recursive: true });
  const batch = await readShellChangeBatch("toolu_x", 0, dir);
  expect(batch).toMatchObject({ quarantined: true, done: true, changes: [] });
  expect(fs.existsSync(file)).toBe(false);
  expect(fs.existsSync(path.join(dir, "quarantine", "toolu_x"))).toBe(true);
});

test("oversized blobs are checked by size and skipped without reading their contents", async () => {
  const { dir } = setup(8, "x".repeat(2_000_000));
  expect(await readShellChangeBatch("toolu_x", 0, dir)).toMatchObject({ done: true, changes: [], next: 8 });
});

test("ordinary messages without shell captures do not write the upload queue", () => {
  const { dir } = setup(1, "small");
  const uploader = worker(async () => {}, dir);
  uploader.enqueue("conv", "uuid", []);
  uploader.enqueue("conv", "uuid", [{ toolUseId: "missing" }]);
  expect(fs.existsSync(path.join(dir, "uploads.json"))).toBe(false);
});


test("diff uploads do not inherit an expired transcript transaction", async () => {
  const { dir } = setup(1, "small");
  let sent = 0;
  const uploader = worker(async () => {
    expect(currentTranscriptDeadline()).toBeUndefined();
    sent++;
  }, dir);
  await withTranscriptDeadline(async () => uploader.enqueue("conv", "uuid", [{ toolUseId: "toolu_x" }]), { timeoutMs: 1 });
  expect(await uploader.waitForCompletion(5000)).toBe(true);
  expect(sent).toBe(1);
});
