const { setup, run, reset } = await import("./harness");
await setup(process.argv[2] as any);
for (let i=0;i<3;i++){ const r = await run(); console.log(JSON.stringify({counts:r.counts, forced:r.detail.forcedLayouts},null,1)); await reset(); }
process.exit(0);
