import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { isSafeStatusSessionId } from "./statusSpool.js";
import { parseAskInputSidecar, readAskInputSidecar } from "./keystrokeInference.js";
import { functionBlock } from "./test-helpers/sourceRegion.js";

const source = fs.readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
function daemonReader(name: string) {
  const reads: string[] = [];
  const stat = (file: string) => { reads.push(file); return { mtimeMs: Date.now() }; };
  const fakeFs = { statSync: stat, readFileSync: () => JSON.stringify({ questions: [{ question: "Continue?" }] }), promises: { stat: async (file: string) => stat(file) } };
  const body = new Bun.Transpiler({ loader: "ts" }).transformSync(functionBlock(source, name).text);
  const fn = new Function("fs", "path", "ASK_INPUT_DIR", "isSafeStatusSessionId", "parseAskInputSidecar", body + `;return ${name}`)(fakeFs, path, "/fixture/ask-input", isSafeStatusSessionId, parseAskInputSidecar);
  return { fn, reads };
}

test.each(["readAskUserQuestionInput", "askInputSidecarMtimeMs"])("%s rejects unsafe IDs before filesystem access", async name => {
  const { fn, reads } = daemonReader(name);
  for (const id of ["../outside", "a/b", "..", ".hidden", "a\\b", "a\u0000"]) expect(await fn(id)).toBeNull();
  expect(reads).toEqual([]);
  expect(await fn("valid-session_1")).not.toBeNull();
  expect(reads).toEqual(["/fixture/ask-input/valid-session_1.json"]);
});

test("async inference sidecar reader rejects traversal to a fresh outside file", async () => {
  const os = await import("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ask-boundary-"));
  try {
    const dir = path.join(root, "ask-input");
    fs.mkdirSync(dir);
    const raw = JSON.stringify({ questions: [{ question: "Continue?" }] });
    fs.writeFileSync(path.join(root, "outside.json"), raw);
    fs.writeFileSync(path.join(dir, "safe.json"), raw);
    expect(await readAskInputSidecar(dir, "../outside", Date.now())).toBeNull();
    expect(await readAskInputSidecar(dir, "safe", Date.now())).toEqual(JSON.parse(raw));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
