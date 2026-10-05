// Attribute a regression, connected: the endpoints from the address, the
// free answer from GET /attribution, and, only when that answer left
// candidates it could not pin, the plan priced by POST /bisect/plan and started
// by POST /bisect. Every change to the plan's settings is priced again by the
// engine, so the bound on screen is the one the run enforces. GET /bisects
// names any bisect already over this range, and the one holding the lock.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { attributionSearchable, EVALS_BATCH_TOKEN_RE, resolveEvalsBatchRef, type Attribution, type BisectPlan, type BisectPlanRequest, type BisectSummary } from "@codecast/shared/contracts/evalsApi";
import { useEvalsChanges, useEvalsClient, useEvalsResource } from "../../../lib/evals/hooks";
import { AttributionView, EndpointsBar, type EndpointsValue } from "../AttributionView";
import { BisectPlanPanel, START_KEY, type PlanSettings } from "../BisectPlanPanel";
import { bisectsOverRange, bisectSummaryWord, endpointLabel, isBisectLive, canStart } from "../bisectModel";
import { EvalsLink, VerdictGlyph } from "../parts";
import { evalsHref, type EvalsView } from "../evalsPaths";
import { usd } from "../format";
import { useEvalsHost } from "../host";

const PRICE_DEBOUNCE_MS = 350;

/** The plan for one searchable pair: defaults first, then each settings change priced by the engine. */
function usePlan(surface: string, good: string, bad: string, onlyFreeze: string | null, allCommits: boolean) {
  const [settings, setSettings] = useState<PlanSettings>({ freezes: [], reps: 3, budgetUsd: null, maxMinutes: null, allCommits });
  const [options, setOptions] = useState<BisectPlan["freezes"]>([]);
  const [plan, setPlan] = useState<BisectPlan | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { call } = useEvalsClient();
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
          const p = await call("POST /bisect/plan", { body: request(settings, !first) });
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
  }, [settings, request, onlyFreeze, call]);

  return { settings, setSettings, options, plan, pending, error, request };
}

function PlanSide({ surface, good, bad, onlyFreeze, allCommits, blockedBy }: { surface: string; good: string; bad: string; onlyFreeze: string | null; allCommits: boolean; blockedBy: { id: string; surface: string | null; listed: boolean } | null }) {
  const host = useEvalsHost();
  const navigate = host.useNavigate();
  const { call, invalidate } = useEvalsClient();
  const { settings, setSettings, options, plan, pending, error, request } = usePlan(surface, good, bad, onlyFreeze, allCommits);
  const [confirm, setConfirm] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const go = canStart({ plan, pending, starting, confirm, settings, blockedBy });

  const start = useCallback(async () => {
    if (!go) return;
    setStarting(true);
    setStartError(null);
    try {
      const res = await call("POST /bisect", { body: { ...request(settings, true), ...(plan?.needsConfirm ? { confirm: true } : {}) } });
      invalidate("GET /bisects");
      navigate(evalsHref.bisect(res.id));
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
      setStarting(false);
    }
  }, [go, request, settings, plan, call, invalidate, navigate]);

  // Enter starts it, the way the list chord opens an item. A focused control
  // keeps its own Enter; nothing starts while the plan cannot.
  host.useShortcuts(
    {
      [START_KEY.action]: {
        keys: START_KEY.keys,
        label: "Start the bisect",
        run: () => {
          if (!go) return false;
          const el = document.activeElement;
          if (el && el !== document.body && el.closest("button, a, select, input, textarea, label") && !el.closest("[data-evb-start]")) return false;
          void start();
          return true;
        },
      },
    },
    host.useActive(),
  );

  return (
    <BisectPlanPanel
      plan={plan}
      pending={pending}
      error={error}
      freezeOptions={options}
      settings={settings}
      onSettings={setSettings}
      blockedBy={blockedBy}
      confirm={confirm}
      onConfirm={setConfirm}
      starting={starting}
      startError={startError}
      onStart={() => void start()}
    />
  );
}

/** The bisects already over this range: what they answered, so nobody pays twice for an answer on record. */
function PriorBisects({ bisects, now }: { bisects: Array<BisectSummary & { same: boolean }>; now: number }) {
  const { timeAgo } = useEvalsHost().format;
  if (!bisects.length) return null;
  return (
    <section className="ev-card ev-b-prior" data-evb-prior={bisects.length}>
      <h2>
        <VerdictGlyph state={bisects.some((b) => b.outcome === "culprit") ? "fail" : "unscored"} size={11} />
        {bisects.length === 1 ? "A bisect already covers this range" : `${bisects.length} bisects already cover this range`}
      </h2>
      {bisects.map((b) => (
        <EvalsLink key={b.id} className="ev-b-prior-row" href={evalsHref.bisect(b.id)} data-evb-prior-row={b.id} data-evb-live={isBisectLive(b.status) || undefined}>
          <span className="ev-mono">{b.id}</span>
          <span className={b.outcome === "culprit" ? "ev-b-prior-word ev-b-prior-word--culprit" : "ev-b-prior-word"}>{bisectSummaryWord(b)}</span>
          <span className="ev-b-prior-ends">
            {b.same ? "these same ends" : `${endpointLabel(b.good)} to ${endpointLabel(b.bad)}`}
          </span>
          <span className="ev-b-prior-when">
            {isBisectLive(b.status) ? `running, started ${timeAgo(Date.parse(b.startedAt), now)} ago` : `${timeAgo(Date.parse(b.finishedAt ?? b.updatedAt), now)} ago, ${usd(b.spentUsd)}`}
          </span>
        </EvalsLink>
      ))}
    </section>
  );
}

export function BisectNewPage({ view }: { view: Extract<EvalsView, { view: "bisect-new" }> }) {
  const host = useEvalsHost();
  const { EmptyState } = host.ui;
  const navigate = host.useNavigate();
  const now = host.useNow(60_000);
  const allCommits = !!view.all;
  const overview = useEvalsResource("GET /overview", {});
  const surfaces = useMemo(() => overview.data?.surfaces.map((s) => s.id) ?? (view.surface ? [view.surface] : []), [overview.data, view.surface]);
  const batches = useMemo(() => overview.data?.surfaces.find((s) => s.id === view.surface)?.strip ?? [], [overview.data, view.surface]);
  // A surface is enough: an end left out is found by Tier 0 from the records (the newest red batch, and its baseline).
  const ready = !!view.surface;
  const attr = useEvalsResource("GET /attribution", ready ? { query: { surface: view.surface!, ...(view.good ? { good: view.good } : {}), ...(view.bad ? { bad: view.bad } : {}), ...(allCommits ? { allCommits: true } : {}), ...(view.freeze ? { freeze: view.freeze } : {}) } } : null);
  const a = attr.data;
  // The address names a labelled batch by its hash (evalsBatchRef); the api resolves it, and the attribution
  // it answers names the batch, so a hashed end is read back from there.
  const named = (ref: string | null, side: "good" | "bad") => (ref && EVALS_BATCH_TOKEN_RE.test(ref) ? (a?.[side].batch ?? resolveEvalsBatchRef(ref, batches.map((b) => b.batch)) ?? ref) : ref);
  const good = named(view.good, "good");
  const bad = named(view.bad, "bad");
  const value: EndpointsValue = { surface: view.surface ?? "", good: good ?? "", bad: bad ?? "" };
  // The ends the plan prices and starts: the ones asked for, else the ones the records found.
  const ends = a ? { good: good || a.good.batch || a.good.sha, bad: bad || a.bad.batch || a.bad.sha } : null;
  // The engine's own rule: a plan is offered whenever a bisect would have work, an unattributable range included.
  const searchable = !!a && attributionSearchable(a);

  // Past and running bisects: one over this range may already hold the answer, and the one holding the lock blocks Start.
  const list = useEvalsResource("GET /bisects", {});
  const live = !!list.data?.bisects.some((b) => isBisectLive(b.status));
  useEvalsChanges(live, (c) => {
    if (c.bisects.length) list.reload();
  });
  const prior = useMemo(() => (a && list.data ? bisectsOverRange(list.data.bisects, a) : []), [a, list.data]);
  const holder = list.data?.running ?? null;
  const held = holder ? list.data?.bisects.find((b) => b.id === holder) : undefined;
  const blockedBy = holder ? { id: holder, surface: held?.surface ?? null, listed: !!held } : null;

  const widen = (on: boolean) => navigate(evalsHref.bisectNew({ surface: view.surface, good: view.good, bad: view.bad, freeze: view.freeze, all: on }));
  const answer = (x: Attribution) => <AttributionView attribution={x} now={now} allCommits={{ on: allCommits, onChange: widen }} />;

  return (
    <div data-evals-page="bisect-new">
      <div className="ev-b-page">
        <header className="ev-b-head">
          <VerdictGlyph state={a ? (a.answer.kind === "noise" ? "pass" : "fail") : "unscored"} size={14} />
          <h1 className="ev-page-title">Attribute a regression</h1>
          {view.surface && (
            <EvalsLink className="ev-chip" href={evalsHref.surface(view.surface)}>
              {view.surface}
            </EvalsLink>
          )}
          {view.freeze && <span className="ev-chip">limited to freeze {view.freeze.slice(0, 8)}</span>}
          {allCommits && <span className="ev-chip">every commit</span>}
          <span className="ev-b-sub">The records answer first, for free. A bisect is offered only when they leave candidates they cannot pin.</span>
          <span className="ev-grow" />
          <EvalsLink className="ev-b-link ev-small" href={evalsHref.bisectList()}>
            All bisects
          </EvalsLink>
        </header>
        <EndpointsBar
          surfaces={surfaces}
          batches={batches}
          value={value}
          resolved={a ? { good: a.good, bad: a.bad } : null}
          onSubmit={(v) => navigate(evalsHref.bisectNew({ ...v, freeze: view.freeze, all: allCommits }))}
        />
        {a && <PriorBisects bisects={prior} now={now} />}
        {!ready ? (
          <div className="ev-b-note" data-evb-needs-endpoints>
            Pick a surface. Each end is a batch name from the surface's chart or a commit sha (a sha stands for the newest clean batch that ran on it); leave an end empty and the records find it: the newest red batch, and its baseline.
          </div>
        ) : a ? (
          searchable ? (
            <div className="ev-b-grid">
              {answer(a)}
              <aside>
                <PlanSide key={`${view.surface}|${ends!.good}|${ends!.bad}|${view.freeze ?? ""}|${allCommits}`} surface={view.surface!} good={ends!.good} bad={ends!.bad} onlyFreeze={view.freeze} allCommits={allCommits} blockedBy={blockedBy} />
              </aside>
            </div>
          ) : (
            answer(a)
          )
        ) : attr.status === 404 ? (
          <EmptyState title={view.good && view.bad ? "No such endpoint" : "Nothing to attribute"} description={attr.error ?? "One end names no batch or commit this surface knows."} />
        ) : attr.error ? (
          <EmptyState title="The records could not be read" description={attr.error} />
        ) : (
          <div className="ev-note" data-evals-loading>
            {view.good && view.bad ? "Walking the records between the two ends..." : "Finding the red batch and its baseline in the records..."}
          </div>
        )}
      </div>
    </div>
  );
}
