#!/usr/bin/env bun
// ./evals: freeze codecast moments, replay the prompts in this tree against
// them on a pinned model, grade every rep, and publish the report. The
// program itself is main.ts.

// The exit code is set, never forced with process.exit: exiting at once drops
// whatever stdout has not drained, and a pipe takes 64 KiB at a time.
//
// `stale` is the cadence precheck and must answer well under a second, so it
// runs before commander or the platform load. A bad argument exits 2, never
// 1, which is the precheck's "nothing changed".
if (process.argv[2] === 'stale' && !process.argv.includes('--help') && !process.argv.includes('-h')) {
  const { staleMain } = await import('./commands/stale');
  try {
    process.exitCode = staleMain(process.argv.slice(3));
  } catch (e) {
    process.stderr.write(`evals: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  }
} else {
  const { main } = await import('./main');
  process.exitCode = await main();
}

export {};
