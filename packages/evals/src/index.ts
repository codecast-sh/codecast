#!/usr/bin/env bun
// ./evals: freeze codecast moments, replay the prompts in this tree against
// them on a pinned model, grade every rep, and publish the report. The
// program itself is main.ts.

// `stale` is the cadence precheck and must answer well under a second, so it
// runs before commander or the platform load.
if (process.argv[2] === 'stale' && !process.argv.includes('--help') && !process.argv.includes('-h')) {
  const { staleMain } = await import('./commands/stale');
  process.exit(staleMain(process.argv.slice(3)));
}

const { main } = await import('./main');
process.exit(await main());

export {};
