// bun's mock.module is one registry for the whole test process, not per file.
// A module that read the mocked value at import keeps the first mock it saw,
// and a later file in the same run inherits the mock (2026-09-23, two web tests
// that each passed alone and failed together). Files that mock the same module
// must install the same shape.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-learning-mock-"));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

const base = {
  "dep.ts": `export const value = "real";\n`,
  "consumer.ts": `import { value } from "./dep";\nexport const seen = value;\n`,
};

describe("bun mock.module", () => {
  test("a module that imported the first mock keeps it after a second mock", () => {
    const dir = project({
      ...base,
      "one.test.ts": `import { expect, mock, test } from "bun:test";
test("x", async () => {
  mock.module("./dep", () => ({ value: "first" }));
  expect((await import("./consumer")).seen).toBe("first");
  mock.module("./dep", () => ({ value: "second" }));
  expect((await import("./dep")).value).toBe("second");
  expect((await import("./consumer")).seen).toBe("first");
});
`,
    });
    const r = spawnSync("bun", ["test", "./one.test.ts"], { cwd: dir, encoding: "utf8" });
    fs.rmSync(dir, { recursive: true, force: true });
    expect(r.status, r.stderr).toBe(0);
  });

  test("a mock installed by one file is what the next file in the run imports", () => {
    const dir = project({
      ...base,
      "a.test.ts": `import { mock, test } from "bun:test";\ntest("a", () => { mock.module("./dep", () => ({ value: "from-a" })); });\n`,
      "b.test.ts": `import { expect, test } from "bun:test";\ntest("b", async () => { expect((await import("./dep")).value).toBe("from-a"); });\n`,
    });
    const together = spawnSync("bun", ["test", "./a.test.ts", "./b.test.ts"], { cwd: dir, encoding: "utf8" });
    const alone = spawnSync("bun", ["test", "./b.test.ts"], { cwd: dir, encoding: "utf8" });
    fs.rmSync(dir, { recursive: true, force: true });
    expect(together.status, together.stderr).toBe(0);
    expect(alone.status).not.toBe(0);
  });
});
