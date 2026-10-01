#!/usr/bin/env bun
/**
 * The daily live check of a cloud agent provider's API, as a trigger
 * precheck (tr-1254). What it checks and what its exit codes mean:
 * src/cloudAgents/canary.ts.
 *
 *   bun packages/cli/scripts/cloud-agent-canary.ts [provider id, default codex]
 *
 * The precheck skips the run on exit 10 (clean) and 11 (could not check yet)
 * and runs it on anything else:
 *
 *   bun packages/cli/scripts/cloud-agent-canary.ts codex; case $? in 10|11) exit 1;; esac
 *
 * The code is loaded inside the try, so a canary that cannot run (an import
 * broken by a half-saved file in the shared tree, a bug) exits 1 and the
 * trigger hears of it, rather than reading as a clean day.
 */
const fail = (err: unknown) => {
  console.log(`the canary could not run: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

try {
  const [{ runCanary }, { cloudAgentAdapters }, { defaultConfigDir }] = await Promise.all([
    import("../src/cloudAgents/canary.js"),
    import("../src/cloudAgents/index.js"),
    import("../src/config/configDir.js"),
  ]);
  const { code, line } = await runCanary(cloudAgentAdapters(), process.argv[2] ?? "codex", defaultConfigDir());
  console.log(line);
  process.exit(code);
} catch (err) {
  fail(err);
}
