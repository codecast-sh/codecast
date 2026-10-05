// /evals/sim: loads the catalog and the session history, and starts a sweep
// (POST /sim/sweep), following its job through GET /changes until it lands.
// After a reload the newest sweep job (GET /sim/sessions lastSweep) stands in
// for the one the page started, so a failed sweep keeps its reason and tail.

import { useCallback, useRef, useState } from "react";
import type { ChangesResponse } from "@codecast/shared/contracts/evalsApi";
import { useEvalsChanges, useEvalsClient, useEvalsResource } from "../../../lib/evals/hooks";
import type { EvalsView } from "../evalsPaths";
import { useEvalsHost } from "../host";
import { SimCatalogView, type SweepState } from "../SimCatalogView";
import { jobLive, jobState, shownJobState } from "../simJobState";

export function SimCatalogPage(_props: { view: Extract<EvalsView, { view: "sim" }> }) {
  const { EmptyState } = useEvalsHost().ui;
  const { call } = useEvalsClient();
  const catalog = useEvalsResource("GET /sim/catalog", {});
  const sessions = useEvalsResource("GET /sim/sessions", {});
  const [sweep, setSweep] = useState<SweepState>({ state: "idle" });
  const jobId = useRef<string | null>(null);

  // A reload forgets this page's job; the newest sweep job says how it went (or that it still runs).
  const shown = shownJobState(sweep, sessions.data?.lastSweep);

  const onChanges = useCallback(
    (changes: ChangesResponse) => {
      const job = changes.jobs.find((j) => j.id === jobId.current) ?? changes.jobs.find((j) => j.kind === "sweep");
      if (!job) return;
      setSweep(jobState(job));
      if (job.status === "running") return;
      catalog.reload();
      sessions.reload();
    },
    [catalog, sessions],
  );
  useEvalsChanges(jobLive(shown), onChanges);

  const onSweep = useCallback(async (filter: string, seeds: number) => {
    setSweep({ state: "starting" });
    try {
      const { job } = await call("POST /sim/sweep", { body: { ...(filter ? { filter } : {}), seeds } });
      jobId.current = job;
      setSweep({ state: "running", job: null });
    } catch (e) {
      setSweep({ state: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }, [call]);

  const error = catalog.error ?? sessions.error;
  if (error && !catalog.data) return <EmptyState title="The Multiplayer sim history did not load" description={error} />;
  if (!catalog.data || !sessions.data) {
    return (
      <div className="ev-page ev-note" data-evals-page="sim" data-evals-loading>
        Reading the scenarios, invariants and sessions...
      </div>
    );
  }
  return <SimCatalogView catalog={catalog.data} sessions={sessions.data.sessions} sweep={shown} onSweep={onSweep} />;
}
