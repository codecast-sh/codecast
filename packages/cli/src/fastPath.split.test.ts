/**
 * `cast --help` is only cheap if the compiled binary is code split (ct-49751).
 *
 * ct-49546 put every command group behind an `await import()`, but a bundler
 * with no splitting simply concatenates those modules into the entry file, and
 * the runtime parses the whole thing before the first statement. The win exists
 * only if `bun build --compile --splitting` keeps them in separate chunks, and
 * that is a fact about bun that nothing in the source tree states — it can be
 * lost by a bun upgrade or by dropping the flag in build-with-native.ts.
 *
 * So this test asks bun directly, in miniature, by the same measure the release
 * check uses on the real artifact: stat the module `import.meta.url` names
 * inside the compiled binary. That number IS what the runtime parsed to reach
 * the first statement. `computer-helper-release.ts` runs the same probe
 * (`cast _boot-bytes`) against the built darwin binary and holds it under
 * BOOT_BYTES_CEILING.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let stage = "";

beforeEach(() => {
  stage = fs.mkdtempSync(path.join(os.tmpdir(), "cast-split-"));
});

afterEach(() => {
  fs.rmSync(stage, { recursive: true, force: true });
});

/** Bytes the compiled entry module holds, the way `cast _boot-bytes` reads it. */
function entryBytes(splitting: boolean): number {
  // Shaped like main.ts: a tiny entry that reaches everything expensive through
  // a dynamic import. The heavy module is generated rather than fixtured so the
  // difference between the two builds is far larger than any bundler preamble.
  fs.writeFileSync(
    path.join(stage, "heavy.ts"),
    Array.from({ length: 5_000 }, (_, i) => `export function f${i}(a: number) { return a * ${i}; }`).join("\n"),
  );
  fs.writeFileSync(
    path.join(stage, "entry.ts"),
    `import { fileURLToPath } from "node:url";\n` +
      `import { statSync } from "node:fs";\n` +
      `if (process.argv[2] === "heavy") { const m = await import("./heavy.ts"); console.log(m.f1(2)); }\n` +
      `else console.log(statSync(fileURLToPath(import.meta.url)).size);\n`,
  );
  const out = path.join(stage, splitting ? "split" : "whole");
  const build = spawnSync(
    process.execPath,
    ["build", path.join(stage, "entry.ts"), "--compile", ...(splitting ? ["--splitting"] : []), "--outfile", out],
    { encoding: "utf8", timeout: 300_000 },
  );
  expect(build.stderr + build.stdout).not.toContain("error:");
  expect(build.status).toBe(0);

  // The lazy half must still work: a split that broke the dynamic import would
  // otherwise pass the byte assertion for the wrong reason.
  const lazy = spawnSync(out, ["heavy"], { encoding: "utf8", timeout: 120_000 });
  expect(lazy.status, lazy.stderr).toBe(0);
  expect(lazy.stdout.trim()).toBe("2");

  const answer = spawnSync(out, [], { encoding: "utf8", timeout: 120_000 });
  expect(answer.status, answer.stderr).toBe(0);
  return Number.parseInt(answer.stdout.trim(), 10);
}

test("bun --compile --splitting keeps a dynamically imported module out of the entry", () => {
  const split = entryBytes(true);
  const whole = entryBytes(false);
  // Two orders of magnitude apart on bun 1.3.14 (about 400 bytes against about
  // 250 KB). A tenth is loose enough to survive bundler preamble churn and
  // still fails outright if the chunks are ever collapsed back together.
  expect(split).toBeLessThan(whole / 10);
}, 300_000); // two compiles
