const { setup, run } = await import("./harness");
await setup("inbox-update" as any);
for (let i = 0; i < 4; i++) { const r: any = await run(); console.log(r.detail.longestSliceMs, r.counts.longTasks, r.counts.storeWrites); }
process.exit(0);
