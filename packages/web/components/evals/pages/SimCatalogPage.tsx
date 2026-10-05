// /evals/sim: loads the catalog and the session history, and starts a sweep
// (POST /sim/sweep), following its job through GET /changes until it lands.

import { useCallback, useRef, useState } from "react";
import type { ChangesResponse } from "@codecast/shared/contracts/evalsApi";
import { EmptyState } from "../../EmptyState";
import { useEvalsChanges, useEvalsResource } from "../../../lib/evals/hooks";
import { useEvalsStore } from "../../../store/evalsStore";
import type { EvalsView } from "../evalsPaths";
import { SimCatalogView, type SweepState } from "../SimCatalogView";

export function SimCatalogPage(_props: { view: Extract<EvalsView, { view: "sim" }> }) {
  const catalog = useEvalsResource("GET /sim/catalog", {});
  const sessions = useEvalsResource("GET /sim/sessions", {});
  const [sweep, setSweep] = useState<SweepState>({ state: "idle" });
  const jobId = useRef<string | null>(null);

  const onChanges = useCallback(
    (changes: ChangesResponse) => {
      const job = changes.jobs.find((j) => j.id === jobId.current);
      if (!job) return;
      if (job.status === "running") return setSweep({ state: "running", job });
      setSweep(job.status === "done" ? { state: "done", job } : { state: "failed", error: `The sweep ${job.status}${job.progress.text ? `: ${job.progress.text}` : ""}`, logTail: job.logTail ?? [] });
      catalog.reload();
      sessions.reload();
    },
    [catalog, sessions],
  );
  useEvalsChanges(sweep.state === "starting" || sweep.state === "running", onChanges);

  const onSweep = useCallback(async (filter: string, seeds: number) => {
    setSweep({ state: "starting" });
    try {
      const { job } = await useEvalsStore.getState().call("POST /sim/sweep", { body: { ...(filter ? { filter } : {}), seeds } });
      jobId.current = job;
      setSweep({ state: "running", job: null });
    } catch (e) {
      setSweep({ state: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const error = catalog.error ?? sessions.error;
  if (error && !catalog.data) return <EmptyState title="The Multiplayer sim history did not load" description={error} />;
  if (!catalog.data || !sessions.data) {
    return (
      <div className="ev-page text-[12px] ev-quiet" data-evals-page="sim" data-evals-loading>
        Reading the scenarios, invariants and sessions...
      </div>
    );
  }
  return <SimCatalogView catalog={catalog.data} sessions={sessions.data.sessions} sweep={sweep} onSweep={onSweep} />;
}
