import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cwdFromTranscript, cwdToSlug } from "./session-move.js";

function transcript(launch: string, cwds: string[]): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cwd-test-")), cwdToSlug(launch));
  fs.mkdirSync(dir);
  const file = path.join(dir, "s.jsonl");
  fs.writeFileSync(file, cwds.map((cwd) => JSON.stringify({ type: "user", cwd })).join("\n") + "\n");
  return file;
}

describe("cwdFromTranscript", () => {
  test("an agent's cd into a subfolder does not move the session there", () => {
    const root = "/Users/ashot/src/codecast";
    expect(cwdFromTranscript(transcript(root, [root, `${root}/packages/web`, `${root}/packages/web`]))).toBe(root);
  });

  test("the newest launch-folder entry wins after a round trip", () => {
    const here = "/Users/ashot/src/codecast";
    expect(cwdFromTranscript(transcript(here, ["/home/ubuntu/work/codecast", here]))).toBe(here);
  });

  test("no entry matching the folder falls back to the newest cwd", () => {
    expect(cwdFromTranscript(transcript("/a/b", ["/x/y", "/x/z"]))).toBe("/x/z");
  });
});
