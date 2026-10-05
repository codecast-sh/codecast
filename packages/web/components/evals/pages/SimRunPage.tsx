// /evals/sim/:session/:run: loads one run in full and starts a shrink
// (POST /sim/shrink). While a shrink runs (this page's job, or one started
// from a terminal, which shows as minimal.json.tmp) it follows GET /changes
// and re-reads the run, so the progress and then the minimal order land here.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangesResponse, SimJob } from "@codecast/shared/contracts/evalsApi";
import { EmptyState } from "../../EmptyState";
import { EVALS_POLL_MS, useEvalsChanges, useEvalsResource } from "../../../lib/evals/hooks";
import { useTabVisible } from "../../../hooks/usePagePresence";
import { useEvalsStore } from "../../../store/evalsStore";
import { evalsHref, type EvalsView } from "../evalsPaths";
import { SimRunView, type ShrinkState } from "../SimRunView";

/** A shrink job that ended without a minimal order: its outcome and the last lines it printed. */
const failedShrink = (job: SimJob): ShrinkState => ({ state: "failed", error: `The shrink ${job.status}${job.progress.text ? `: ${job.progress.text}` : ""}`, logTail: job.logTail ?? [] });

export function SimRunPage({ view }: { view: Extract<EvalsView, { view: "sim-run" }> }) {
  const res = useEvalsResource("GET /sim/run/:session/:run", { params: { session: view.session, run: view.run } });
  const [shrink, setShrink] = useState<ShrinkState>({ state: "idle" });
  const jobId = useRef<string | null>(null);
  const visible = useTabVisible();
  const { reload } = res;

  // A reload forgets this page's job; the run's newest shrink job says how it went (or that it still runs).
  const last = res.data?.lastShrink ?? null;
  const shown: ShrinkState = shrink.state !== "idle" || !last ? shrink : last.status === "running" ? { state: "running", job: last } : last.status === "done" ? shrink : failedShrink(last);
  const live = shown.state === "starting" || shown.state === "running" || !!res.data?.shrinking;

  const onChanges = useCallback(
    (changes: ChangesResponse) => {
      const job = changes.jobs.find((j) => j.id === jobId.current) ?? changes.jobs.find((j) => j.kind === "shrink" && j.session === view.session && j.run === view.run);
      if (!job) return;
      if (job.status === "running") setShrink({ state: "running", job });
      else setShrink(job.status === "done" ? { state: "idle" } : failedShrink(job));
      reload();
    },
    [view.session, view.run, reload],
  );
  useEvalsChanges(live, onChanges);

  // minimal.json.tmp moves between job reports; re-read it on the same clock while on screen.
  useEffect(() => {
    if (!live || !visible) return;
    const id = setInterval(reload, EVALS_POLL_MS);
    return () => clearInterval(id);
  }, [live, visible, reload]);

  const onShrink = useCallback(async () => {
    setShrink({ state: "starting" });
    try {
      const { job } = await useEvalsStore.getState().call("POST /sim/shrink", { body: { session: view.session, run: view.run } });
      jobId.current = job;
      setShrink({ state: "running", job: null });
    } catch (e) {
      setShrink({ state: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }, [view.session, view.run]);

  if (!res.data) {
    if (res.status === 404)
      return <EmptyState title="No such Multiplayer sim run" description={`Session ${view.session} has no run folder ${view.run}. Older sessions are pruned when they hold no failure.`} action={{ label: "Open the Multiplayer sim", href: evalsHref.sim() }} />;
    if (res.error) return <EmptyState title="This Multiplayer sim run did not load" description={res.error} />;
    return (
      <div className="ev-page text-[12px] ev-quiet" data-evals-page="sim-run" data-evals-loading>
        Reading the run's deliveries...
      </div>
    );
  }
  return <SimRunView data={res.data} shrink={shown} onShrink={() => void onShrink()} />;
}
