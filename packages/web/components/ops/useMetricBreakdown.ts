// What a metric alert counted, split by the metric's own source: a HogQL
// count watch is asked again with the same filter grouped by what each event
// was (issuesModel hogqlBreakdown), so the Errors card ranks the parts of the
// number that tripped the alert rather than another source's errors. A read
// from PostHog through the source, kept for a few minutes per watch in this tab.
import { useState } from "react";
import { useAction } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { hogqlBreakdown } from "./issuesModel";
import { scopeOfSource } from "./watchQuery";
import type { OpsSource, OpsWatch } from "./opsTypes";

const api = _api as any;

/** How long one breakdown stands before the card asks PostHog again. */
const FRESH_MS = 5 * 60_000;
const answers = new Map<string, { at: number; results: unknown }>();

export type MetricBreakdown = { state: "none" } | { state: "reading" } | { state: "rows"; results: unknown; at: number } | { state: "error"; error: string };

export function useMetricBreakdown(watch: Pick<OpsWatch, "_id" | "query_kind" | "query"> | undefined, source: Pick<OpsSource, "_id" | "workspace" | "provider"> | undefined): MetricBreakdown {
  const run = useAction(api.sources.posthog.query);
  const query = watch && source?.provider === "posthog" && watch.query_kind === "hogql" ? hogqlBreakdown(watch.query) : null;
  const key = query && watch ? `${watch._id}|${query}` : null;
  const [out, setOut] = useState<MetricBreakdown>(() => {
    const hit = key ? answers.get(key) : undefined;
    return hit ? { state: "rows", results: hit.results, at: hit.at } : { state: "none" };
  });
  useWatchEffect(() => {
    if (!key || !query || !source) return setOut({ state: "none" });
    const hit = answers.get(key);
    if (hit) setOut({ state: "rows", results: hit.results, at: hit.at });
    if (hit && Date.now() - hit.at < FRESH_MS) return;
    let live = true;
    if (!hit) setOut({ state: "reading" });
    run({ ...scopeOfSource(source as OpsSource), source: source._id, query }).then(
      (res: { results?: unknown }) => {
        const at = Date.now();
        answers.set(key, { at, results: res?.results ?? [] });
        if (live) setOut({ state: "rows", results: res?.results ?? [], at });
      },
      (e: unknown) => {
        if (live && !hit) setOut({ state: "error", error: e instanceof Error ? (e.message.split("Uncaught Error:").pop() ?? e.message).trim().split("\n")[0] : "PostHog did not answer" });
      },
    );
    return () => {
      live = false;
    };
  }, [key]);
  return out;
}
