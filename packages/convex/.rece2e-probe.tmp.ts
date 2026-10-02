// Start a track composite of the live share exactly as recordNewShares does,
// watch its status for 90 s, then stop it and report. Writes under the
// harness prefix only.
import * as fs from "node:fs";
import { loadLivekitEnv } from "../web/scripts/call-e2e/livekit.mjs";
Object.assign(process.env, loadLivekitEnv());
for (const l of fs.readFileSync("/tmp/rece2e/bucket.env", "utf8").split("\n")) { const i = l.indexOf("="); if (i > 0) process.env[l.slice(0, i)] = l.slice(i + 1); }
const { livekitConfigFromEnv, listParticipants, startTrackCompositeEgress, trackCompositeEgressRequest, egressS3Upload, getEgress, stopEgress } = await import("./convex/lib/livekitServer");
const { callRecordingsBucketFromEnv } = await import("./convex/lib/r2");
const { screenSharesToRecord, screenEncoding } = await import("./convex/lib/callRecordingRuns");
const cfg = livekitConfigFromEnv()!;
const bucket = callRecordingsBucketFromEnv()!;
const room = "session:jx783b0pmkwtj02cgkwq6tt1418fhfp7";
const share = screenSharesToRecord(await listParticipants(cfg, room), [])[0];
const advanced = screenEncoding(share);
console.log("share", share.trackSid, JSON.stringify(advanced));
const filepath = `call-e2e-harness/probe-${Date.now()}-screen-${share.trackSid}.mp4`;
const t0 = Date.now();
const base: any = trackCompositeEgressRequest({ room, videoTrackSid: share.trackSid, filepath, upload: egressS3Upload(bucket), ...(advanced ? { advanced } : {}), liveFrame: { prefix: filepath.replace(/\.mp4$/, "-live"), intervalSeconds: 2 } });
delete base.file_outputs;
const eg = await startTrackCompositeEgress(cfg, base);
console.log("started", eg.egressId, eg.status);
let last = "";
while (Date.now() - t0 < 90_000) {
  await new Promise((r) => setTimeout(r, 5000));
  const e = await getEgress(cfg, eg.egressId);
  const s = `${e?.status} ${e?.error ?? ""}`;
  if (s !== last) { console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s`, s); last = s; }
}
await stopEgress(cfg, eg.egressId).catch((e) => console.log("stop err", String(e)));
await new Promise((r) => setTimeout(r, 15000));
const fin = await getEgress(cfg, eg.egressId);
console.log("final", fin?.status, fin?.error ?? "", JSON.stringify((fin as any)?.files ?? (fin as any)?.file ?? null).slice(0, 300));
console.log("key", filepath);
