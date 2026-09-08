/**
 * `mock.module` is banned in this package's tests. Fake the boundary instead.
 *
 * bun installs a module mock PROCESS-WIDE and never lifts it: re-registering
 * the real module in `afterAll` does not undo it, because ESM binds imports
 * once. `bun test src/` is one process, so a mock in file 3 is still answering
 * in file 300 — and what it answers is not a failure, it is a plausible wrong
 * value. That is how a stub `apiPost` made `cast review add` post nothing and
 * print ok, failing reviewCommand.test.ts 150 files later (ct-49918), and how
 * computer/helperApp.test.ts left every later suite reading the helper payload
 * through its own stub (ct-49941).
 *
 * If this fails on your code, fake what the real module TALKS TO and let the
 * real module run: `globalThis.fetch` for anything over HTTP
 * (integrations.test.ts), a spawn or filesystem fake for a subprocess, or an
 * explicit parameter on the function under test when the value is simply an
 * input it cannot otherwise reach (`materializeHelperApp({ payload })`).
 *
 * A mock inside a string is not a mock: several tests write a fixture program
 * and run it as a SEPARATE process, where a process-wide mock costs nothing
 * and dies with it. So the scan reads code only, with strings and comments
 * removed.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC = path.resolve(import.meta.dir);

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist") testFiles(file, out);
    } else if (entry.name.endsWith(".test.ts")) {
      out.push(file);
    }
  }
  return out;
}

/**
 * The source with every comment and string literal blanked to spaces, so line
 * and column numbers still line up with the original.
 *
 * Nested backticks inside a `${}` interpolation would end the span early; the
 * result is a FALSE POSITIVE, which is loud, rather than a miss.
 */
export function codeOnly(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === "//") {
      const end = text.indexOf("\n", i);
      blank(i, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end;
    } else if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      blank(i, end === -1 ? text.length : end + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (text[i] === '"' || text[i] === "'" || text[i] === "`") {
      const quote = text[i];
      let j = i + 1;
      while (j < text.length && text[j] !== quote) j += text[j] === "\\" ? 2 : 1;
      blank(i, Math.min(j + 1, text.length));
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

describe("no test installs a process-wide module mock", () => {
  test("mock.module appears in no test file's executable code", () => {
    const offenders: string[] = [];
    for (const file of testFiles(SRC)) {
      const code = codeOnly(fs.readFileSync(file, "utf-8"));
      code.split("\n").forEach((line, i) => {
        if (/\bmock\s*\.\s*module\b/.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test("the scan reads code, not strings and comments", () => {
    // A guard that blanked everything would pass forever, so pin both halves.
    expect(codeOnly('const a = "mock.module(x)";').includes("mock.module")).toBe(false);
    expect(codeOnly("// mock.module(x)").includes("mock.module")).toBe(false);
    expect(codeOnly("const s = `run(mock.module(x))`;").includes("mock.module")).toBe(false);
    expect(codeOnly('mock.module("./x.js", () => ({}));').includes("mock.module")).toBe(true);
    // Line numbers survive, or an offender would be reported against the wrong line.
    expect(codeOnly('// a\nmock.module("x");').split("\n")[1]).toContain("mock.module");
  });
});
