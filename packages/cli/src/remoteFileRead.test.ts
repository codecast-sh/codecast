import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { READ_FILE_MAX_BYTES } from "@codecast/shared/contracts";
import { readFileForWeb } from "./remoteFileRead";

let dir: string;
let root: string;

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "read-file-")));
  root = path.join(dir, "family");
  fs.mkdirSync(path.join(root, "x-growth/daily"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, "x-growth/daily/2026-11-12.md"), "# Daily\n\nposted 1\n");
  fs.writeFileSync(path.join(root, ".git/config"), "[core]\n");
  fs.writeFileSync(path.join(root, ".env.local"), "TOKEN=x\n");
  fs.writeFileSync(path.join(root, ".credentials.json"), "{}\n");
  fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([1, 0, 2]));
  fs.writeFileSync(path.join(root, "big.txt"), "a".repeat(READ_FILE_MAX_BYTES + 10));
  fs.writeFileSync(path.join(dir, "outside.md"), "no\n");
  fs.symlinkSync(path.join(dir, "outside.md"), path.join(root, "link.md"));
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("readFileForWeb", () => {
  test("reads a file inside a tracked root", () => {
    const out = readFileForWeb(path.join(root, "x-growth/daily/2026-11-12.md"), [root]);
    expect(out).toEqual({ result: expect.objectContaining({ exists: true, content: "# Daily\n\nposted 1\n", truncated: false }) });
  });

  test("a missing file inside a root is an answer, not an error", () => {
    expect(readFileForWeb(path.join(root, "x-growth/daily/nope.md"), [root])).toEqual({ result: { exists: false } });
  });

  test("refuses paths outside the roots, in .git, secret-named, or linked out", () => {
    for (const p of [path.join(dir, "outside.md"), path.join(root, ".git/config"), path.join(root, ".env.local"), path.join(root, ".credentials.json"), path.join(root, "link.md")]) {
      expect(readFileForWeb(p, [root])).toEqual({ error: "Path not allowed" });
    }
  });

  test("refuses relative paths, folders and binary files", () => {
    expect("error" in readFileForWeb("x-growth/daily/2026-11-12.md", [root])).toBe(true);
    expect(readFileForWeb(path.join(root, "x-growth"), [root])).toEqual({ error: "read_file: not a file" });
    expect(readFileForWeb(path.join(root, "bin.dat"), [root])).toEqual({ error: "read_file: binary file" });
  });

  test("cuts a long file at the cap and says so", () => {
    const out = readFileForWeb(path.join(root, "big.txt"), [root]);
    if (!("result" in out)) throw new Error("expected a result");
    expect(out.result.content?.length).toBe(READ_FILE_MAX_BYTES);
    expect(out.result.truncated).toBe(true);
  });
});
