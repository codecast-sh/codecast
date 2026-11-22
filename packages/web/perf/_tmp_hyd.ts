const { setup, run } = await import("./harness");
await setup("hydrate" as any);
for (let i = 0; i < 2; i++) { const r: any = await run(); console.log(JSON.stringify(r.counts), r.detail.longestSliceMs); }
process.exit(0);
