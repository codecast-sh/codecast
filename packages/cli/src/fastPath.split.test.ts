/**
 * `cast --help` is only cheap if the compiled binary is code split (ct-49751).
 *
 * Every command group sits behind an `await import()`, and the runtime parses
 * the whole entry module before the first statement. This test pins that
 * `bun build --compile --splitting` keeps a lazily imported module out of the
 * entry, by the measure the release check uses: stat the module
 * `import.meta.url` names inside the compiled binary. It does not show that
 * an unsplit build is larger: for this toy, bun 1.4.4 leaves the module out
 * of the entry without --splitting as well (316 bytes unsplit against 276
 * split; 311,283 against 339 on 1.3.14). The real CLI's entry is guarded by
 * BOOT_BYTES_CEILING in `computer-helper-release.ts`, which runs the same
 * probe (`cast _boot-bytes`) against the built darwin binary.
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
function entryBytes(): number {
  // Shaped like main.ts: a tiny entry that reaches everything expensive through
  // a dynamic import. The heavy module is generated rather than fixtured so it is
  // far larger than any bundler preamble.
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
  const out = path.join(stage, "split");
  const build = spawnSync(
    process.execPath,
    ["build", path.join(stage, "entry.ts"), "--compile", "--splitting", "--outfile", out],
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
  // The generated module is about 300 KB. Bun 1.4.4 leaves a dynamic import
  // out of the entry even without --splitting in this toy (a few hundred
  // bytes), where 1.3.14 concatenated it (311,485), so only the split build is asserted:
  // it must stay far below the module it would otherwise have swallowed. The
  // release artifact is held to BOOT_BYTES_CEILING by computer-helper-release.ts.
  expect(entryBytes()).toBeLessThan(10_000);
}, 300_000); // one compile
