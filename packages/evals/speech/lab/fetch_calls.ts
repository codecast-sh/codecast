// Pull recorded huddles into the speech lab: the call (segments with per-track speakers, via
// `cast call --json`) and each composite recording's audio as 16 kHz mono WAV.
//   bun lab/fetch_calls.ts cl-180 cl-137 ...   then: python lab/datasets.py calls <ids>
import { readAuthConfig } from "../../../cli/src/config/readAuthConfig";
import { execFileSync } from "node:child_process";
import os from "node:os"; import path from "node:path"; import fs from "node:fs";
const HOME = process.env.SPEECH_LAB_HOME ?? path.join(os.homedir(), ".codecast/diarize-lab");
const cfg: any = readAuthConfig(path.join(os.homedir(), ".codecast"), {});
const site = cfg.convex_url.replace(".cloud", ".site");
const post = async (p: string, b: any) => (await fetch(site + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_token: cfg.auth_token, ...b }) })).json();
for (const c of process.argv.slice(2)) {
  const dir = path.join(HOME, "calls", c); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "call.json"), execFileSync("cast", ["call", c, "--json"]));
  const recs = await post("/cli/calls/recordings", { call: c });
  fs.writeFileSync(path.join(dir, "recordings.json"), JSON.stringify(recs, null, 1));
  (recs.recordings ?? []).forEach((r: any, i: number) => {
    if (r.kind !== "composite" || !r.url) return;
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", r.url, "-vn", "-ac", "1", "-ar", "16000", path.join(dir, `composite${i}.wav`)]);
    console.log(c, i, `${Math.round(r.duration_ms / 1000)}s`);
  });
}
