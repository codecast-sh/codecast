// The line sweep's own switch (the-line.md L9): whether codecast starts
// causes on its own at all, for every line, whatever a role's switch says.
// crons.ts registers orgLine.sweep only while this is true, and the line map
// says so when it is not (orgLine.queue sweep_on). Off: it started a run on
// every open task assigned to a direct-trust role's agent, within caps, and
// each run spends model time, so turning it on is a person's call.
// A leaf with no imports, so crons.ts reads it without orgLine's module graph.
export const LINE_SWEEP_ON = false;
