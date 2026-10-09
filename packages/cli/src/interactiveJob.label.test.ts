import { describe, expect, setDefaultTimeout, test } from "bun:test";
import * as path from "node:path";
import { spawnSync } from "./proc.js";
import { LAUNCHD_LABEL_ENV } from "./launchdJob.js";

// However the wrapper runs a command — as a launchd job, or inline because
// launchd declined it — the child must see the label. A script gated on it
// re-execs itself through the wrapper while it is unset
// (packages/convex/deploy.sh), so a child without one wraps itself without
// end: over SSH on a cloud Mac, where there is no gui/<uid> domain to take
// the job, a deploy nested nine wrappers deep in ten minutes and took every
// Interactive job slot with it.
setDefaultTimeout(120_000);

const script = path.join(import.meta.dir, "..", "scripts", "run-interactive.ts");

describe("the interactive wrapper", () => {
  test("hands the command a label whichever way it runs it", () => {
    const r = spawnSync("bun", [script, "--", "/bin/bash", "-c", `printf '%s' "$${LAUNCHD_LABEL_ENV}"`], {
      encoding: "utf-8",
      // A label in this process's own environment would short-circuit the
      // wrapper, which is the one path that cannot regress.
      env: { ...process.env, [LAUNCHD_LABEL_ENV]: undefined } as NodeJS.ProcessEnv,
    });
    expect(r.status).toBe(0);
    expect(String(r.stdout).trim()).not.toBe("");
  });
});
