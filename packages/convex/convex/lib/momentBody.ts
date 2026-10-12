// What the web (lineMoments.ts) and the CLI (moments.ts) both read of a
// moment: its kept body out of R2, and one judge run as a row. A leaf with no
// Convex functions, so either module imports it without pulling the other in.
import { gunzipSync, strFromU8 } from "fflate";
import type { Doc } from "../_generated/dataModel";
import type { MomentRecord } from "@codecast/shared/contracts/moments";
import type { JudgeFinding } from "@codecast/shared/contracts/judges";
import { replaysBucketFromEnv, r2Presign } from "./r2";

/** A moment's kept body, by its R2 key. The object is stored with Content-Encoding gzip (replays.putChunk), so fetch
 *  may hand it back already decoded: it is unzipped only when it still starts with gzip's magic bytes. Null when the
 *  bucket is not configured or the object is gone. */
export async function readKeptBody(key: string | null): Promise<MomentRecord | null> {
  const bucket = replaysBucketFromEnv();
  if (!key || !bucket) return null;
  const res = await fetch(await r2Presign(bucket, "GET", key, 300));
  if (!res.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const gz = bytes[0] === 0x1f && bytes[1] === 0x8b;
  return JSON.parse(strFromU8(gz ? gunzipSync(bytes) : bytes));
}

export type JudgeRunRow = {
  judge: string;
  judge_version: string;
  mode: "shadow" | "live";
  status: "ok" | "failed" | "skipped";
  reason?: string;
  findings: JudgeFinding[];
  uncited?: number;
  filed: number;
  model: string;
  cost_usd: number;
  at: number;
};

/** One judge run on a moment as both readers show it: its verdict, findings and cost. */
export function judgeRunRow(r: Doc<"judge_runs">): JudgeRunRow {
  return {
    judge: r.judge,
    judge_version: r.judge_version,
    mode: r.mode,
    status: r.status,
    ...(r.reason ? { reason: r.reason } : {}),
    findings: r.findings_json ? JSON.parse(r.findings_json) : [],
    ...(r.uncited ? { uncited: r.uncited } : {}),
    filed: r.signal_ids?.length ?? 0,
    model: r.model,
    cost_usd: r.cost_usd,
    at: r.at,
  };
}
