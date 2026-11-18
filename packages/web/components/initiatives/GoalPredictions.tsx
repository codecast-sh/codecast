"use client";
// What the goal's tasks predicted for its numbers, and what each number did
// after the task shipped (shared/contracts/predictedEffect.ts). Read from the
// tasks in the store, where the prediction and its reading live; drawn only
// when a task predicts something.
import { useMemo } from "react";
import Link from "next/link";
import { type InitiativeRow } from "@codecast/shared/contracts/initiative";
import { hitRateWords, predictionTally, predictionText, realisedLine, PREDICTION_VERDICT_WORDS, type PredictedEffect, type RealisedEffect } from "@codecast/shared/contracts/predictedEffect";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { useMetricSeries } from "../../hooks/useMetricSeries";
import { RecordSection as Section } from "./InitiativeRecord";

type PredictingTask = { _id: string; short_id: string; title: string; status: string; predicted?: PredictedEffect; realised?: RealisedEffect };

const DIM = "var(--sol-text-dim)";
const VERDICT_COLOR: Record<string, string> = { held: "var(--sol-green)", opposite: "var(--sol-red)", not_shown: "var(--sol-yellow)", unreadable: DIM, open: DIM };
const predictionSig = (t: PredictingTask) => (t.predicted ? `${t.predicted.goal_ref}|${t.predicted.set_at}|${t.realised?.read_at ?? ""}|${t.title}` : "");

export function GoalPredictions({ goal }: { goal: InitiativeRow }) {
  const tasks = useWorkspaceCollection<PredictingTask>("tasks", predictionSig);
  const { lookup } = useMetricSeries();
  const rows = useMemo(() => {
    const prefix = `${goal.short_id}:`;
    return tasks
      .filter((t) => t.predicted?.goal_ref.startsWith(prefix))
      .sort((a, b) => (b.realised?.read_at ?? b.predicted!.set_at) - (a.realised?.read_at ?? a.predicted!.set_at));
  }, [tasks, goal.short_id]);
  if (!goal.short_id || !rows.length) return null;
  const units = new Map((goal.metrics ?? []).map((m) => [m.key, (m.series ? lookup(m.series)?.unit : null) ?? null]));
  const names = new Map((goal.metrics ?? []).map((m) => [m.key, m.name]));
  return (
    <div className="mt-5">
      <Section name="predictions" label="Predictions" count={rows.length} action={<span className="text-meta" style={{ color: DIM }}>{hitRateWords(predictionTally(rows))}</span>}>
        <ul className="space-y-1.5" data-goal-predictions>
          {rows.map((t) => {
            const p = t.predicted!, r = t.realised;
            const verdict = r?.verdict ?? "open";
            const key = p.goal_ref.slice(goal.short_id.length + 1);
            const said = predictionText(p).split(" :: ")[0].slice(p.goal_ref.length + 1);
            const what = `${names.get(key) ?? key} ${r ? realisedLine(p, r, units.get(key)).replace(/^[a-z ]+: /, "") : `${said}${p.read_at ? "" : " after ship"}`}`;
            return (
              <li key={t._id} className="flex items-baseline gap-2 min-w-0 text-[13px]" data-goal-prediction={t.short_id} data-verdict={verdict} title={`Basis: ${p.basis}`}>
                <span className="shrink-0 w-[72px] text-meta" style={{ color: VERDICT_COLOR[verdict] }}>{r ? PREDICTION_VERDICT_WORDS[r.verdict] : "open"}</span>
                <Link href={`/tasks/${t.short_id}`} className="shrink-0 no-underline hover:underline" style={{ color: "var(--sol-cyan)" }}>{t.short_id}</Link>
                <span className="shrink-0 max-w-[75%] truncate" title={what}>{what}</span>
                <span className="min-w-0 truncate text-meta" style={{ color: DIM }}>{t.title}</span>
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}
