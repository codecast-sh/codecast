// /evals/sim/:session/:run: loads one run in full and starts a shrink
// (POST /sim/shrink). While a shrink runs (this page's job, or one started
// from a terminal, which shows as minimal.json.tmp) it follows GET /changes
// and re-reads the run, so the progress and then the minimal order land here.

import { useCallback, useRef, useState } from "react";
import { useInterval } from "../../../hooks/useInterval";
import type { ChangesResponse } from "@codecast/shared/contracts/evalsApi";
import { EVALS_POLL } from "@platform/evals/client";
import { useEvalsChanges, useEvalsClient, useEvalsResource } from "../../../lib/evals/hooks";
import type { EvalsView } from "@platform/evals/client";
import { evalsHref } from "../evalsPaths";
import { useEvalsHost } from "@platform/evals/react";
import { SimRunView, type ShrinkState } from "../SimRunView";
import { jobLive, jobState, shownJobState } from "../simJobState";

export function SimRunPage({ view }: { view: Extract<EvalsView, { view: "sim-run" }> }) {
  const host = useEvalsHost();
  const { EmptyState } = host.ui;
  const { call } = useEvalsClient();
  const res = useEvalsResource("GET /sim/run/:session/:run", { params: { session: view.session, run: view.run } });
  const [shrink, setShrink] = useState<ShrinkState>({ state: "idle" });
  const jobId = useRef<string | null>(null);
  const visible = host.useVisible();
  const { reload } = res;

  // A reload forgets this page's job; the run's newest shrink job says how it went (or that it still runs).
  const shown = shownJobState(shrink, res.data?.lastShrink);
  const live = jobLive(shown) || !!res.data?.shrinking;

  const onChanges = useCallback(
    (changes: ChangesResponse) => {
      const job = changes.jobs.find((j) => j.id === jobId.current) ?? changes.jobs.find((j) => j.kind === "shrink" && j.session === view.session && j.run === view.run);
      if (!job) return;
      setShrink(jobState(job));
      reload();
    },
    [view.session, view.run, reload],
  );
  useEvalsChanges(live, onChanges);

  // minimal.json.tmp moves between job reports; re-read it on the same clock while on screen.
  useInterval(reload, EVALS_POLL.intervalMs, live && visible);

  const onShrink = useCallback(async () => {
    setShrink({ state: "starting" });
    try {
      const { job } = await call("POST /sim/shrink", { body: { session: view.session, run: view.run } });
      jobId.current = job;
      setShrink({ state: "running", job: null });
    } catch (e) {
      setShrink({ state: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }, [call, view.session, view.run]);

  if (!res.data) {
    if (res.status === 404)
      return <EmptyState title="No such Multiplayer sim run" description={`Session ${view.session} has no run folder ${view.run}. Older sessions are pruned when they hold no failure.`} action={{ label: "Open the Multiplayer sim", href: evalsHref.sim() }} />;
    if (res.error) return <EmptyState title="This Multiplayer sim run did not load" description={res.error} />;
    return (
      <div className="ev-page ev-note" data-evals-page="sim-run" data-evals-loading>
        Reading the run's deliveries...
      </div>
    );
  }
  return <SimRunView data={res.data} shrink={shown} onShrink={() => void onShrink()} />;
}
