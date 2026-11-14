// Temporary: stage timing of a screenshot read on a real window. Deleted before handoff.
import { ComputerClient } from "../src/computer/client.js";
import { helperExecutablePath } from "../src/computer/helperApp.js";
import { disclaimedHelperLaunch } from "../src/test-helpers/computerPermissionProbe.js";
import { rewriteScreenshotForJson } from "../src/computer/screenshotFile.js";
const app = process.argv[2] ?? "Finder";
const extra = JSON.parse(process.argv[3] ?? "{}");
const client = new ComputerClient({ helperLaunch: (s, t) => disclaimedHelperLaunch(helperExecutablePath(), ["--agent", s, "--token-file", t]) });
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!.toFixed(0);
await client.getAppState({ app, noScreenshot: true });
const no: number[] = [], yes: number[] = [], write: number[] = [];
let bytes = 0, dims = "";
for (let i = 0; i < 7; i++) {
  let t = performance.now(); await client.getAppState({ app, noScreenshot: true, ...extra }); no.push(performance.now() - t);
  t = performance.now(); const r = await client.getAppState({ app, ...extra }); yes.push(performance.now() - t);
  bytes = (r.screenshot as any)?.data?.length ?? (r.screenshot as any)?.bytes ?? 0; dims = `${r.screenshot?.width}x${r.screenshot?.height} ${r.screenshot?.format}`;
  t = performance.now(); rewriteScreenshotForJson(r); write.push(performance.now() - t);
}
console.log(`${app}: noshot ${med(no)} ms  shot ${med(yes)} ms  cli-write ${med(write)} ms  payload ${bytes} chars  ${dims}`);
console.log(JSON.stringify({ no, yes, write }));
client.shutdown(); process.exit(0);
