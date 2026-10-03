// Attribute a regression, connected: the endpoints from the address, the
// free answer from GET /attribution, and, only when that answer narrowed the
// range without pinning it, the plan priced by POST /bisect/plan and started
// by POST /bisect. Every change to the plan's settings is priced again by the
// engine, so the bound on screen is the one the run enforces.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BisectPlan, BisectPlanRequest } from "@codecast/shared/contracts/evalsApi";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useTabActive } from "../../../hooks/usePagePresence";
import { useEvalsResource } from "../../../lib/evals/hooks";
import { useEvalsStore } from "../../../store/evalsStore";
import { usePaneShortcutAction, useShortcutContext } from "../../../shortcuts";
import { EmptyState } from "../../EmptyState";
import { AttributionView, EndpointsBar, type EndpointsValue } from "../AttributionView";
import { BisectPlanPanel, canStart, type PlanSettings } from "../BisectPlanPanel";
import { EvalsLink, VerdictGlyph } from "../parts";
import { evalsHref, type EvalsView } from "../evalsPaths";
import "../bisect.css";

const PRICE_DEBOUNCE_MS = 350;

/** The plan for one narrowed pair: defaults first, then each settings change priced by the engine. */
function usePlan(surface: string, good: string, bad: string, onlyFreeze: string | null) {
  const [settings, setSettings] = useState<PlanSettings>({ freezes: [], reps: 3, budgetUsd: null, maxMinutes: null, allCommits: false });
  const [options, setOptions] = useState<BisectPlan["freezes"]>([]);
  const [plan, setPlan] = useState<BisectPlan | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const seeded = useRef(false);
  /** The settings the plan on screen was priced for, so seeding the defaults costs no second request. */
  const priced = useRef<string | null>(null);

  const request = useCallback(
    (s: PlanSettings, withFreezes: boolean): BisectPlanRequest => ({
      surface,
      good,
      bad,
      ...(withFreezes ? { freezes: s.freezes } : {}),
      reps: s.reps,
      ...(s.budgetUsd !== null ? { budgetUsd: s.budgetUsd } : {}),
      ...(s.maxMinutes !== null ? { maxMinutes: s.maxMinutes } : {}),
      allCommits: s.allCommits,
    }),
    [surface, good, bad],
  );

  useEffect(() => {
    if (priced.current === JSON.stringify(settings)) return;
    const mine = ++seq.current;
    const first = !seeded.current;
    setPending(true);
    const t = setTimeout(
      async () => {
        try {
          // The first plan is the engine's default set (flipped plus two controls), which becomes the freeze list.
          const p = await useEvalsStore.getState().call("POST /bisect/plan", { body: request(settings, !first) });
          if (mine !== seq.current) return;
          if (first) {
            seeded.current = true;
            const opts = onlyFreeze && !p.freezes.some((f) => f.id === onlyFreeze) ? [...p.freezes, { id: onlyFreeze, name: onlyFreeze.slice(0, 8), role: "flipped" as const }] : p.freezes;
            setOptions(opts);
            if (onlyFreeze) {
              setSettings({ ...settings, freezes: [onlyFreeze] });
              return;
            }
            const seededSettings = { ...settings, freezes: p.freezes.map((f) => f.id) };
            priced.current = JSON.stringify(seededSettings);
            setSettings(seededSettings);
          } else priced.current = JSON.stringify(settings);
          setPlan(p);
          setError(null);
          setPending(false);
        } catch (e) {
          if (mine !== seq.current) return;
          setError(e instanceof Error ? e.message : String(e));
          setPending(false);
        }
      },
      first ? 0 : PRICE_DEBOUNCE_MS,
    );
    return () => clearTimeout(t);
  }, [settings, request, onlyFreeze]);

  return { settings, setSettings, options, plan, pending, error, request };
}

function PlanSide({ surface, good, bad, onlyFreeze, offerAllCommits }: { surface: string; good: string; bad: string; onlyFreeze: string | null; offerAllCommits: boolean }) {
  const router = useRouter();
  const { settings, setSettings, options, plan, pending, error, request } = usePlan(surface, good, bad, onlyFreeze);
  const [confirm, setConfirm] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const go = canStart({ plan, pending, starting, confirm, settings });

  const start = useCallback(async () => {
    if (!go) return;
    setStarting(true);
    setStartError(null);
    try {
      const res = await useEvalsStore.getState().call("POST /bisect", { body: { ...request(settings, true), ...(plan?.needsConfirm ? { confirm: true } : {}) } });
      useEvalsStore.getState().invalidate("GET /bisects");
      router.push(evalsHref.bisect(res.id));
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
      setStarting(false);
    }
  }, [go, request, settings, plan, router]);

  // Enter starts it, the way the list chord opens an item. A focused control
  // keeps its own Enter; nothing starts while the plan cannot.
  const active = useTabActive();
  useShortcutContext("list", active);
  usePaneShortcutAction("list.open", () => {
    if (!go) return false;
    const el = document.activeElement;
    if (el && el !== document.body && el.closest("button, a, select, input, textarea, label") && !el.closest("[data-evb-start]")) return false;
    void start();
    return true;
  });

  return (
    <BisectPlanPanel
      plan={plan}
      pending={pending}
      error={error}
      freezeOptions={options}
      settings={settings}
      onSettings={setSettings}
      offerAllCommits={offerAllCommits}
      confirm={confirm}
      onConfirm={setConfirm}
      starting={starting}
      startError={startError}
      onStart={() => void start()}
    />
  );
}

export function BisectNewPage({ view }: { view: Extract<EvalsView, { view: "bisect-new" }> }) {
  const router = useRouter();
  const now = useCoarseNow(60_000);
  const value: EndpointsValue = { surface: view.surface ?? "", good: view.good ?? "", bad: view.bad ?? "" };
  const overview = useEvalsResource("GET /overview", {});
  const surfaces = useMemo(() => overview.data?.surfaces.map((s) => s.id) ?? (view.surface ? [view.surface] : []), [overview.data, view.surface]);
  const batches = useMemo(() => overview.data?.surfaces.find((s) => s.id === view.surface)?.strip ?? [], [overview.data, view.surface]);
  const ready = !!(view.surface && view.good && view.bad);
  const attr = useEvalsResource("GET /attribution", ready ? { query: { surface: view.surface!, good: view.good!, bad: view.bad! } } : null);
  const a = attr.data;
  const narrowed = a?.answer.kind === "source" && a.answer.confidence === "narrowed";

  return (
    <div data-evals-page="bisect-new">
      <div className="evb-page">
        <header className="evb-head">
          <VerdictGlyph state={a ? (a.answer.kind === "noise" ? "pass" : "fail") : "unscored"} size={14} />
          <h1>Attribute a regression</h1>
          {view.surface && (
            <EvalsLink className="ev-chip" href={evalsHref.surface(view.surface)}>
              {view.surface}
            </EvalsLink>
          )}
          {view.freeze && <span className="ev-chip">limited to freeze {view.freeze.slice(0, 8)}</span>}
          <span className="evb-sub">The records answer first, for free. A bisect is offered only when they narrow the range without pinning it.</span>
          <span className="flex-1" />
          <EvalsLink className="evb-link text-[12px]" href={evalsHref.bisectList()}>
            All bisects
          </EvalsLink>
        </header>
        <EndpointsBar
          surfaces={surfaces}
          batches={batches}
          value={value}
          resolved={a ? { good: a.good, bad: a.bad } : null}
          onSubmit={(v) => router.push(evalsHref.bisectNew({ ...v, freeze: view.freeze }))}
        />
        {!ready ? (
          <div className="evb-note" data-evb-needs-endpoints>
            Pick a surface and two endpoints. Each end is a batch name from the surface's chart or a commit sha; a sha stands for the newest clean batch that ran on it.
          </div>
        ) : a ? (
          narrowed ? (
            <div className="evb-grid">
              <AttributionView attribution={a} now={now} />
              <aside>
                <PlanSide key={`${view.surface}|${view.good}|${view.bad}|${view.freeze ?? ""}`} surface={view.surface!} good={view.good!} bad={view.bad!} onlyFreeze={view.freeze} offerAllCommits={a.answer.kind === "source" && a.answer.noDeclaredSourceMoved} />
              </aside>
            </div>
          ) : (
            <AttributionView attribution={a} now={now} />
          )
        ) : attr.status === 404 ? (
          <EmptyState title="No such endpoint" description={attr.error ?? "One end names no batch or commit this surface knows."} />
        ) : attr.error ? (
          <EmptyState title="The records could not be read" description={attr.error} />
        ) : (
          <div className="text-[12px] ev-quiet" data-evals-loading>
            Walking the records between the two ends...
          </div>
        )}
      </div>
    </div>
  );
}
