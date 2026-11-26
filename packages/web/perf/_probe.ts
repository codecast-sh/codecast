const { run, setup, reset } = await import("./harness");
await setup("inbox-load");
const r = await run();
console.log(JSON.stringify({ counts: r.counts, kinds: r.detail.layoutReadKinds, sites: r.detail.layoutReads, renderMs: r.detail.renderMs }, null, 1));
await reset();
process.exit(0);
