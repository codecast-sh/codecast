// A synthetic app connector for the Apps board's tests: a manifest with a
// high-risk and a low-risk action, two watched readers, a view, and an audit
// with repeated watch failures, a refusal and good calls. Nothing here is real.
import { parseAppManifest, type AppManifest } from "@codecast/shared/contracts/appConnector";
import type { OpsAppCall, OpsSource } from "../opsTypes";

export const NOW = Date.parse("2026-10-12T22:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const parsed = parseAppManifest({
  name: "acme",
  version: "5e45eba09f",
  readers: [
    { name: "jobs.failed", title: "Recent job failures", method: "GET", path: "/codecast/jobs/failed", description: "The most recent failed jobs, newest first: queue, id, the error, retries and when it failed.", input: { type: "object", properties: { limit: { type: "integer", description: "How many" } } } },
    { name: "invariants.list", title: "Invariants", method: "GET", path: "/codecast/invariants", description: "Every invariant with its latest result.", input: { type: "object" } },
    { name: "errors.stats", title: "Error counts", method: "GET", path: "/codecast/errors/stats", description: "Error counts by severity over a window.", input: { type: "object" } },
  ],
  actions: [
    { name: "jobs.rerun", title: "Rerun a job", method: "POST", path: "/codecast/jobs/rerun", idempotent: false, risk: "high", description: "Enqueue a job again with the payload it ran with. A rerun repeats whatever the job does.", input: { type: "object", required: ["jobName", "jobId"], properties: { jobName: { type: "string" }, jobId: { type: "string" } } } },
    { name: "jobs.cancel", title: "Cancel a job", method: "POST", path: "/codecast/jobs/cancel", idempotent: true, risk: "low", description: "Cancel a pending or scheduled job.", input: { type: "object" } },
    { name: "views.token", title: "Open an Acme view", method: "POST", path: "/codecast/views/token", idempotent: true, risk: "low", description: "A short-lived url that frames one of Acme's own screens.", input: { type: "object" } },
  ],
  watches: [
    { reader: "jobs.failed", every: "5m", kind: "job", map: { id: "id", ok: "ok", at: "failedAt" } },
    { reader: "invariants.list", every: "1h", kind: "check", map: { id: "id", ok: "ok" } },
  ],
  views: [{ name: "person", title: "Person", path: "/embed/person", params: [], description: "One contact's profile." }],
});
if (!parsed.ok) throw new Error(`fixture manifest: ${parsed.errors.join("; ")}`);
export const MANIFEST: AppManifest = parsed.manifest;

export const SOURCE = { _id: "src1", name: "acme", provider: "app" as const, status: "active" as const };

export const UNREACHABLE = "watch job:jobs.failed: Could not reach the app at https://acme.example: error sending request for url (https://acme.example/api/codecast/jobs/failed): client error (Connect): Connection reset by peer (os error 104)";

let n = 0;
const call = (over: Partial<OpsAppCall>): OpsAppCall => ({ _id: `call${n++}`, source_id: SOURCE._id, user_id: "u1", kind: "read", name: "jobs.failed", args_hash: "", status: "ok", ms: 120, bytes: 400, created_at: NOW, ...over });
const watchFail = (ago: number, error = "watch job:jobs.failed: no answer in 15s") => call({ status: "error", error, ms: 15_003, bytes: 0, created_at: NOW - ago });

/** Good calls today, a refusal ten minutes ago, and watch failures that stopped two days ago. */
export const CALLS: OpsAppCall[] = [
  call({ kind: "do", name: "views.token", http_status: 200, created_at: NOW - MIN }),
  call({ kind: "do", name: "views.token", status: "denied", error: "views.token is not granted: a person grants it in the browser, under Ops, Apps. An agent cannot grant it.", ms: 0, bytes: 0, created_at: NOW - 10 * MIN }),
  call({ name: "errors.stats", http_status: 200, created_at: NOW - 10 * MIN }),
  watchFail(2 * DAY),
  watchFail(3 * DAY, UNREACHABLE),
  ...Array.from({ length: 12 }, (_, i) => watchFail(5 * DAY + i * HOUR)),
  watchFail(6 * DAY, "watch job:jobs.failed: answered 502"),
];

type BoardSource = Pick<OpsSource, "_id" | "name" | "provider" | "status" | "last_error" | "grants" | "watch_state" | "manifest_fetched_at">;

/** The source's row as the board reads it: two of three actions granted, both watches polling clean. */
export function source(over: Partial<BoardSource> = {}): BoardSource {
  return {
    ...SOURCE,
    manifest_fetched_at: NOW - 10 * MIN,
    grants: [
      { action: "jobs.cancel", granted_by: "u1", granted_at: NOW - 6 * DAY, via: "session" },
      { action: "views.token", granted_by: "u1", granted_at: NOW - 2 * MIN, via: "session" },
    ],
    watch_state: [
      { key: "job:jobs.failed", polled_at: NOW - 2 * MIN },
      { key: "check:invariants.list", polled_at: NOW - 40 * MIN },
    ],
    ...over,
  };
}
