// A metric reader's answer for a `reader` watch (metrics.ts): the app
// connector call a poll and a history read make, through the same credential,
// manifest and signature every other call to the product takes (sources/app).
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { parseReaderQuery, readMetricAnswer } from "@codecast/shared/contracts/ingest";
import { buildAppRequest, formatActorHeader, validateJson } from "@codecast/shared/contracts/appConnector";
import { isTokenRefusal } from "../lib/sourceHealth";
import type { FetchLike } from "../tokenConnectors";
import { appCredential, appHttp, auditOutsideCall, freshManifest, signerOf, type RunCtx } from "./app";

/**
 * One metric reader's answer for a watch (contracts/ingest readMetricAnswer):
 * its number now, its unit, and the dated points it holds. `days` asks the
 * reader for that much history when its input declares a `days` field. `lost`
 * says the connection itself is gone or refused, so the source stops polling.
 * A successful read writes no app_calls row, like a manifest watch.
 */
export async function readAppMetric(
  ctx: RunCtx,
  sourceId: Id<"event_sources">,
  query: string,
  fetchImpl: FetchLike,
  opts: { days?: number } = {},
): Promise<{ ok: true; value: number | null; unit: string | null; points: Array<{ at: number; value: number }> } | { ok: false; error: string; lost?: boolean }> {
  const parsed = parseReaderQuery(query);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const found = await ctx.runQuery(internal.sources.app.sourceForPoll, { source_id: sourceId });
  if (!found || found.source.status !== "active") return { ok: false, error: "the source is not active" };
  const source: Doc<"event_sources"> = found.source;
  const cred = await appCredential(ctx, found.connection_id);
  if (!cred.ok) return { ok: false, error: cred.error, lost: true };
  const m = await freshManifest(ctx, source, found.connection_id, fetchImpl, Date.now());
  if (!m.ok) return { ok: false, error: m.error };
  const reader = m.manifest.readers.find((r) => r.name === parsed.reader);
  if (!reader) return { ok: false, error: `${source.name} declares no reader ${parsed.reader}` };
  const takesDays = !!(reader.input as any)?.properties?.days;
  const args = { ...parsed.args, ...(opts.days && takesDays ? { days: Math.round(opts.days) } : {}) };
  const invalid = validateJson(reader.input, args);
  if (invalid.length) return { ok: false, error: `invalid args: ${invalid.join("; ")}` };
  const req = buildAppRequest(cred.base_url, reader, args);
  if (!req.ok) return { ok: false, error: req.error };
  const res = await appHttp(fetchImpl, req, { token: cred.token, actor: formatActorHeader({ watch: parsed.reader }), sign: signerOf(source) });
  if (!res.ok) {
    await auditOutsideCall(ctx, { source_id: source._id, user_id: source.owner_user_id, kind: "read", name: parsed.reader, args }, "error", { error: `metric ${parsed.reader}: ${res.error ?? "failed"}`, ms: res.ms, bytes: res.bytes, http_status: res.status });
    return { ok: false, error: res.error ?? "failed", ...(isTokenRefusal(res.status) ? { lost: true } : {}) };
  }
  let body: unknown;
  try {
    body = JSON.parse(res.text ?? "");
  } catch {
    return { ok: false, error: "the answer is not JSON" };
  }
  return { ok: true, ...readMetricAnswer(body) };
}
