// The CI station's test fixtures: job logs recorded from GitHub, trimmed, and how a test reads failures.

// Recorded from a codecast test-cli job log (GitHub's job-logs API), trimmed.
export const BUN_LOG = `2026-11-20T16:32:42.5694615Z ##[group]src/bench/bootGraph.guard.test.ts:
2026-11-20T16:32:42.5695355Z (pass) command groups stay off the boot graph > every listed group resolves to a module that exists [0.39ms]
2026-11-20T16:32:42.5698230Z
2026-11-20T16:32:42.5698612Z ##[endgroup]
2026-11-20T16:32:42.5701591Z ##[group]src/bench/bootGraph.guard.test.ts:
2026-11-20T16:32:42.5706082Z 721 |     // 616 on 2026-11-20: subagentFinish.ts (node imports only), which marks a finished
2026-11-20T16:32:42.5707929Z 723 |     expect(graph.nodes.size, "source files on daemon.ts's static graph").toBeLessThanOrEqual(616);
2026-11-20T16:32:42.5709170Z                                                                                ^
2026-11-20T16:32:42.5710118Z error: source files on daemon.ts's static graph
2026-11-20T16:32:42.5710353Z
2026-11-20T16:32:42.5710448Z Expected: <= 616
2026-11-20T16:32:42.5710656Z Received: 617
2026-11-20T16:32:42.5710777Z
2026-11-20T16:32:42.5711319Z       at <anonymous> (/home/runner/work/app/app/packages/cli/src/bench/bootGraph.guard.test.ts:723:74)
2026-11-20T16:32:42.5711774Z
2026-11-20T16:32:42.5735606Z ##[error]Expected: <= 616
Received: 617

      at <anonymous> (/home/runner/work/app/app/packages/cli/src/bench/bootGraph.guard.test.ts:723:74)
2026-11-20T16:32:42.5746042Z (fail) command groups stay off the boot graph > the daemon carries no CLI command group either [120.84ms]
2026-11-20T16:32:42.5747242Z (pass) command groups stay off the boot graph > commandGroups.ts is a leaf: it imports no repo module at runtime [0.39ms]
2026-11-20T16:38:42.3064716Z 1 tests failed:
2026-11-20T16:38:42.3065139Z (fail) command groups stay off the boot graph > the daemon carries no CLI command group either [120.84ms]
2026-11-20T16:38:42.3066419Z  1 fail
2026-11-20T16:38:42.6071615Z ##[error]Process completed with exit code 1.
2026-11-20T16:38:42.7000000Z Cleaning up orphan processes`;
export const BUN_TEST = "command groups stay off the boot graph > the daemon carries no CLI command group either";
export const OTHER_TEST_LOG = BUN_LOG.replace(/the daemon carries no CLI command group either/g, "a test main breaks");
export const STEP_END = (code = 1) => `2026-11-20T16:38:42.6071615Z ##[error]Process completed with exit code ${code}.`;
export const bunLogBody = BUN_LOG.split("\n").filter((l) => !/Process completed|orphan/.test(l)).join("\n");
export const VITE_LOG = (msg: string, exit = 1) => `2026-11-20T16:40:00.0Z vite v5.4.0 building for production...
2026-11-20T16:40:01.0Z error during build: ${msg}
2026-11-20T16:40:02.0Z ##[error]Process completed with exit code ${exit}.
2026-11-20T16:40:03.0Z Terminate orphan process: pid (3112) (tmux: server)`;
export const mergeLog = (head: string, main: string) => `2026-11-20T16:31:59.6165267Z HEAD is now at 5b5bb47 Merge ${head} into ${main}\n`;
export const tests = (fs_: Array<{ job: string; test: string | null }>) => fs_.map((f) => [f.job, f.test]);
