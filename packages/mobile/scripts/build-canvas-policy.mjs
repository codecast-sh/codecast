const build = await Bun.build({
  entrypoints: [new URL("../lib/vendor/canvasPolicy.entry.ts", import.meta.url).pathname],
  target: "browser",
  minify: true,
});
if (!build.success) throw new Error(build.logs.join("\n"));
const source = await build.outputs[0].text();
await Bun.write(new URL("../lib/vendor/canvasPolicySource.ts", import.meta.url), `export const CANVAS_POLICY_SOURCE = ${JSON.stringify(source)};\n`);
