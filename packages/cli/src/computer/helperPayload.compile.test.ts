/**
 * The `codecast computer.app` tar rides into the darwin CLI as a bundled file
 * asset, so nothing in the source tree proves it is really there: `helper.tar`
 * is empty in a checkout and holds bytes only for the length of a build. The
 * one place the claim is checkable is a COMPILED binary, which is what the
 * release records a sha256 for in its artifact manifest (ct-49524).
 *
 * So this test does what the release does, in miniature: stage bytes at the
 * payload path, `bun build --compile`, run the result, and demand the sha256 it
 * reports back equals the sha256 the manifest would have recorded. It catches
 * the two ways the mechanism dies quietly — bun dropping the asset from a
 * compiled binary, and the runtime failing to resolve it back to a readable
 * file — either of which ships a macOS CLI whose `cast computer` cannot start.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sha256File } from "../../scripts/computer-helper-release.ts";
import { COMPUTER_HELPER_PAYLOAD } from "../../scripts/build-with-native.ts";

let stage = "";

beforeEach(() => {
  stage = fs.mkdtempSync(path.join(os.tmpdir(), "cast-helper-compile-"));
});

afterEach(() => {
  // The payload is a tracked file that is empty everywhere except inside a
  // build. Leaving bytes in it would put 2 MB of binary in someone's diff.
  fs.writeFileSync(COMPUTER_HELPER_PAYLOAD, "");
  fs.rmSync(stage, { recursive: true, force: true });
});

function compileAndAsk(): string {
  const entry = path.join(stage, "ask.ts");
  // Imports the real helperPayload.ts, so the asset is resolved exactly the way
  // the CLI resolves it — a fixture copy would only test bun.
  fs.writeFileSync(
    entry,
    `import { createHash } from "node:crypto";\n` +
      `import { computerHelperTar } from ${JSON.stringify(path.join(import.meta.dir, "helperPayload.ts"))};\n` +
      `const tar = computerHelperTar();\n` +
      `console.log(tar ? createHash("sha256").update(tar).digest("hex") : "none");\n`,
  );
  const out = path.join(stage, "ask");
  const build = spawnSync(process.execPath, ["build", entry, "--compile", "--outfile", out], { encoding: "utf8", timeout: 300_000 });
  expect(build.stderr + build.stdout).not.toContain("error:");
  expect(build.status).toBe(0);
  const answer = spawnSync(out, [], { encoding: "utf8", timeout: 120_000 });
  expect(answer.status, answer.stderr).toBe(0);
  return answer.stdout.trim();
}

test("a compiled binary reports the sha256 of the payload it was built with", () => {
  // Real tar bytes rather than filler: the payload is always a tar of the app
  // bundle, and a tar is what the marker check in the release script looks for.
  const bundle = path.join(stage, "codecast computer.app", "Contents", "MacOS");
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, "codecast-computer"), "not a real helper, but real tar bytes");
  const tar = path.join(stage, "payload.tar");
  expect(spawnSync("/usr/bin/tar", ["-cf", tar, "-C", stage, "codecast computer.app"]).status).toBe(0);
  fs.copyFileSync(tar, COMPUTER_HELPER_PAYLOAD);

  expect(compileAndAsk()).toBe(sha256File(tar));
});

test("a compiled binary with an empty payload reports no helper", () => {
  // The non-macOS case: build-with-native.ts leaves the file empty, and every
  // caller must read that as "the feature is not in this build" rather than as
  // a zero-byte helper.
  fs.writeFileSync(COMPUTER_HELPER_PAYLOAD, "");
  expect(compileAndAsk()).toBe("none");
});
