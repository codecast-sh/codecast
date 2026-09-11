import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ageSessionFileIndexForTests, findSessionFile, refreshSessionFileIndex, resetSessionFileIndexForTests, workflowAgentTranscriptPathFor } from "./daemon.js";

let home: string;
let priorHome: string | undefined;
let project: string;
const id = "89b2bd61-7fdc-4491-89fc-7e64dbe39844";
const spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  priorHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-index-"));
  process.env.HOME = home;
  project = path.join(home, ".claude", "projects", "project");
  fs.mkdirSync(project, { recursive: true });
  resetSessionFileIndexForTests();
});

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  await refreshSessionFileIndex();
  process.env.HOME = priorHome;
  resetSessionFileIndexForTests();
  fs.rmSync(home, { recursive: true, force: true });
});

function writeWorkflow(sessionId = id): string {
  const file = path.join(project, "parent", "subagents", "workflows", "run", `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}\n");
  return file;
}

test("cold and concurrent recovery checks share asynchronous enumeration", async () => {
  const file = writeWorkflow();
  fs.writeFileSync(path.join(project, `${id}.jsonl`), "{}\n");
  const exists = spyOn(fs, "existsSync");
  const readdir = spyOn(fs, "readdirSync");
  const reads = spyOn(fs.promises, "readdir");
  spies.push(exists, readdir, reads);
  let timerRan = false;
  const timer = new Promise<void>(resolve => setImmediate(() => { timerRan = true; resolve(); }));
  const results = await Promise.all(Array.from({ length: 50 }, (_, i) => workflowAgentTranscriptPathFor(i % 2 ? "absent" : id)));
  expect(results.filter(Boolean)).toEqual(Array(25).fill(file));
  expect(timerRan).toBe(true);
  expect(exists).not.toHaveBeenCalled();
  expect(readdir).not.toHaveBeenCalled();
  const coldReads = reads.mock.calls.length;
  expect(coldReads).toBeGreaterThan(0);
  expect(await workflowAgentTranscriptPathFor("another-absent")).toBeNull();
  expect(reads.mock.calls.length).toBe(coldReads);
  await timer;
  exists.mockRestore();
  expect(findSessionFile(id)?.path).toBe(path.join(project, `${id}.jsonl`));
});

test("refresh discovers new workflow origins and removes deleted ones", async () => {
  expect(await workflowAgentTranscriptPathFor(id)).toBeNull();
  const file = writeWorkflow();
  ageSessionFileIndexForTests(2100);
  expect(await workflowAgentTranscriptPathFor(id)).toBe(file);
  fs.unlinkSync(file);
  ageSessionFileIndexForTests(2100);
  expect(await workflowAgentTranscriptPathFor(id)).toBeNull();
});

test("an incomplete scan defers recovery instead of granting absence", async () => {
  const original = fs.promises.readdir;
  const reads = spyOn(fs.promises, "readdir").mockImplementation(((dir: unknown, ...args: unknown[]) => {
    if (String(dir) === project) return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
    return (original as any)(dir, ...args);
  }) as any);
  spies.push(reads);
  await expect(workflowAgentTranscriptPathFor(id)).rejects.toThrow("Transcript index unavailable");
  reads.mockRestore();
  const file = writeWorkflow();
  expect(await workflowAgentTranscriptPathFor(id)).toBe(file);
});

test("changing HOME cannot reuse another home's workflow origin", async () => {
  writeWorkflow();
  expect(await workflowAgentTranscriptPathFor(id)).not.toBeNull();
  const other = path.join(home, "other");
  fs.mkdirSync(other);
  process.env.HOME = other;
  expect(await workflowAgentTranscriptPathFor(id)).toBeNull();
});
