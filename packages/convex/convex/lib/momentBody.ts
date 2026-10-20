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
  return await readKeptJson<MomentRecord>(key);
}

/** Any JSON object kept in the replays bucket gzipped (a moment body, an agent review's transcript), read as readKeptBody reads a body. */
export async function readKeptJson<T>(key: string | null): Promise<T | null> {
  const bucket = replaysBucketFromEnv();
  if (!key || !bucket) return null;
  const res = await fetch(await r2Presign(bucket, "GET", key, 300));
  if (!res.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const gz = bytes[0] === 0x1f && bytes[1] === 0x8b;
  return JSON.parse(strFromU8(gz ? gunzipSync(bytes) : bytes));
}

/** A moment's body key while the body is still in R2: a kept body has no expiry, a 30-day one until body_expires_at. */
export function liveBodyKey(m: Pick<Doc<"moments">, "body_key" | "body_expires_at"> | null | undefined, now: number): string | null {
  if (!m?.body_key) return null;
  return m.body_expires_at == null || m.body_expires_at > now ? m.body_key : null;
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

/** A moment's row as both readers show it. `kept` says a body was stored (its key); with `now` it also says the body is
 *  still there (kept for good, or inside its 30 days). The web passes no `now`: a query's result is cached until a row it read changes, so a
 *  clock read there goes stale, and the client judges `body_expires_at` against its own clock. */
export function momentView(m: Doc<"moments">, now?: number) {
  return {
    short_id: m.short_id,
    kind: m.kind,
    subject: m.subject,
    status: m.status,
    events: m.events,
    first_event_at: m.first_event_at,
    event_at: m.event_at,
    ...(m.extracted_at ? { extracted_at: m.extracted_at, gap_ms: m.gap_ms } : {}),
    ...(m.extractor_version ? { extractor_version: m.extractor_version } : {}),
    ...(m.who ? { who: m.who } : {}),
    storage: m.storage ?? "host",
    kept: now == null ? !!m.body_key : liveBodyKey(m, now) !== null,
    ...(m.body_expires_at ? { body_expires_at: m.body_expires_at } : {}),
    ...(m.blocks !== undefined ? { blocks: m.blocks } : {}),
    ...(m.error ? { error: m.error } : {}),
    ...(m.judged_at ? { judged_at: m.judged_at } : {}),
    created_at: m.created_at,
  };
}

/** The event refs that triggered a moment, parsed. */
export const momentRefs = (m: Pick<Doc<"moments">, "refs_json">): Record<string, string> => (m.refs_json ? JSON.parse(m.refs_json) : {});
