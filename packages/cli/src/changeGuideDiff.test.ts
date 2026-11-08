import { afterAll, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { guideDiffReader } from "./changeGuideDiff";

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guide-diff-")));
const sh = (cmd: string) => execSync(cmd, { cwd: repo, stdio: "pipe" });
sh("git init -q && git config user.email t@t && git config user.name t");
fs.mkdirSync(path.join(repo, "outreach/backend/src"), { recursive: true });
fs.writeFileSync(path.join(repo, "outreach/backend/src/a.ts"), "one\n");
fs.writeFileSync(path.join(repo, "outreach/backend/src/gone.ts"), "bye\n");
sh("git add -A && git commit -qm base");
fs.writeFileSync(path.join(repo, "outreach/backend/src/a.ts"), "one\ntwo\n");
fs.rmSync(path.join(repo, "outreach/backend/src/gone.ts"));
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("guideDiffReader", () => {
  test("a path written from a package directory resolves to the root and finds its diff", () => {
    const reader = guideDiffReader(path.join(repo, "outreach"), "HEAD");
    expect(reader.resolve("backend/src/a.ts")).toBe("outreach/backend/src/a.ts");
    expect(reader.diffFor("backend/src/a.ts")).toContain("+two");
    // A deleted file has no disk copy but keeps its diff.
    expect(reader.resolve("backend/src/gone.ts")).toBe("outreach/backend/src/gone.ts");
  });

  test("a root-relative path stays as written, from any directory", () => {
    const reader = guideDiffReader(path.join(repo, "outreach/backend"), "HEAD");
    expect(reader.resolve("outreach/backend/src/a.ts")).toBe("outreach/backend/src/a.ts");
    expect(reader.resolve("no/such/file.ts")).toBe("no/such/file.ts");
    expect(reader.diffFor("no/such/file.ts")).toBeNull();
  });
});
