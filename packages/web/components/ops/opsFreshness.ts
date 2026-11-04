// How fresh the Ops area's numbers are, as one reading for the shell's
// header. Pure: no React, no store.
import { relTimeShort } from "@codecast/shared/time";
import { POLL_LATE_MS, pollLateAfter } from "./sourceHealth";
import type { OpsSource, OpsWatch } from "./opsTypes";

const POLLED = new Set(["posthog", "sentry", "app", "github"]);
/** A vendor poll older than this means the numbers may be behind: the same line a source's own health reads as Poll late. */
export const POLL_STALE_MS = POLL_LATE_MS;

/**
 * How fresh the area is, as one reading for the shell's header: offline (the
 * socket is down, so nothing new arrives), a feed failed, a polled source
 * behind (named, so the header can link to it), or live. Null with no source:
 * nothing is connected, so nothing is live. Pure, so it is tested alone.
 */
export function freshness(opts: { connected: boolean; offlineSince: number | null; feedError: boolean; sources: readonly (Pick<OpsSource, "provider" | "status" | "last_poll_at" | "name"> & Partial<Pick<OpsSource, "_id">>)[]; now: number; /** Watches, for each source's own poll cadence (pollLateAfter): the same line its health reads as Poll late. */ watches?: readonly Pick<OpsWatch, "source_id" | "status" | "interval_ms">[]; /** The source the view is scoped to: the chip speaks for it alone, never for another source. */ scope?: string | null }): { stale: boolean; label: string; title: string; source: string | null } | null {
  const { now } = opts;
  const scoped = opts.scope ? opts.sources.filter((s) => s.name === opts.scope) : null;
  if (!opts.sources.length) return null;
  if (!opts.connected) return { stale: true, label: opts.offlineSince ? `Offline for ${relTimeShort(opts.offlineSince, now)}` : "Offline", title: "Not connected: these numbers are what this device last received", source: null };
  if (opts.feedError) return { stale: true, label: "Feed failed", title: "A list failed to load: some numbers may be behind", source: null };
  const polled = (scoped ?? opts.sources).filter((s) => POLLED.has(s.provider) && s.status === "active" && s.last_poll_at);
  // The source furthest behind is the one to name.
  const lateAfter = (s: (typeof polled)[number]) => (s._id ? pollLateAfter({ _id: s._id }, opts.watches) : POLL_STALE_MS);
  const behind = polled.filter((s) => now - s.last_poll_at! > lateAfter(s)).sort((a, b) => a.last_poll_at! - b.last_poll_at!)[0];
  // Inside the late source's own view its health line already names it: the chip says how late, without repeating the name.
  if (behind && scoped) return { stale: true, label: `Polled ${relTimeShort(behind.last_poll_at!, now)} ago`, title: `${behind.name} last polled ${new Date(behind.last_poll_at!).toLocaleString()}`, source: null };
  if (behind) return { stale: true, label: `Stale: ${behind.name} ${relTimeShort(behind.last_poll_at!, now)}`, title: `${behind.name} last polled ${new Date(behind.last_poll_at!).toLocaleString()}`, source: behind.name };
  const newest = polled.length ? Math.max(...polled.map((s) => s.last_poll_at!)) : null;
  return { stale: false, label: "Live", title: newest !== null ? `Vendors last polled ${new Date(newest).toLocaleString()}` : "Pushed events arrive as they happen", source: null };
}
