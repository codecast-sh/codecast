import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { daemonBuildIdDefine } from "../scripts/build-with-native.js";
import { DAEMON_BUILD_ID } from "./daemonBuildId.js";

test("a CLI run from source carries no build id", () => {
  expect(DAEMON_BUILD_ID).toBeNull();
});

// The id is no longer committed, so the build's define is the only way it
// reaches a binary. A define that stops landing would leave every release
// without an id and bounce the daemon on each one.
test("a build carries the id build-with-native defines", () => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "cast-build-id-"));
  try {
    const entry = path.join(stage, "entry.ts");
    fs.writeFileSync(entry, `import { DAEMON_BUILD_ID } from ${JSON.stringify(path.join(import.meta.dir, "daemonBuildId.ts"))};\nconsole.log(DAEMON_BUILD_ID);\n`);
    const out = path.join(stage, "out.js");
    const build = spawnSync(process.execPath, ["build", entry, "--target=bun", "--outfile", out, ...daemonBuildIdDefine("0123456789ab")], { encoding: "utf8" });
    expect(build.status, build.stderr).toBe(0);
    const run = spawnSync(process.execPath, [out], { encoding: "utf8" });
    expect(run.stdout.trim()).toBe("0123456789ab");
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}, 60_000);
