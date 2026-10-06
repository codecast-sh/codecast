// The priced plan (docs/architecture/evals-ui.md 4.5, section 5): shown only
// when the free answer narrowed the range without pinning it. It carries the
// Tier 1 render classes, the freeze set (the flipped freezes plus two stable
// controls), reps, budget and time, and the cost bound in plain words. The
// engine prices every change (POST /bisect/plan), so the bound shown is the
// one `check --budget` will enforce. Agent surfaces ask for a confirm.

import { canStart, plural, PLAN_REPS, planOverBudget, shortSha, usd } from "../../client";
import type { BisectPlan } from "../../contract";
import { useEvalsHost, useEvalsPaths } from "../hooks";
import { CopyCommand, EvalsLink, VerdictGlyph } from "../shell/parts";

/** The key that starts the bisect, the way the list chord opens an item: the page binds it, the button draws it. */
export const START_KEY = { action: "list.open", keys: "enter" } as const;

export interface PlanSettings {
  freezes: string[];
  reps: number;
  /** null: the engine's default, 1.2 times the bound. */
  budgetUsd: number | null;
  maxMinutes: number | null;
  allCommits: boolean;
}

export interface BisectPlanPanelProps {
  plan: BisectPlan | null;
  /** A plan for the current settings is being priced. */
  pending: boolean;
  error: string | null;
  /** Every freeze the default set offered, so unticking one keeps it on the list. */
  freezeOptions: BisectPlan["freezes"];
  settings: PlanSettings;
  onSettings: (s: PlanSettings) => void;
  /** The bisect holding the one-bisect lock (GET /bisects `running`): Start waits for it. */
  /** The bisect holding the one-bisect lock. `listed` is false for one the pages cannot open (a Multiplayer sim bisect keeps sim.json, not state.json). */
  blockedBy?: { id: string; surface: string | null; listed: boolean } | null;
  confirm: boolean;
  onConfirm: (v: boolean) => void;
  starting: boolean;
  startError: string | null;
  onStart: () => void;
}

function numberOrNull(v: string): number | null {
  const n = Number(v);
  return v.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : n;
}

export function BisectPlanPanel(props: BisectPlanPanelProps) {
  const { plan, pending, error, freezeOptions, settings, onSettings, blockedBy, confirm, onConfirm, starting, startError, onStart } = props;
  const over = plan ? planOverBudget(plan, settings.budgetUsd) : false;
  const go = canStart(props);
  const host = useEvalsHost();
  const href = useEvalsPaths().href;
  const { KeyCap, SegmentedToggle } = host.ui;
  const keys = host.keyParts(START_KEY.action, START_KEY.keys);
  const set = (patch: Partial<PlanSettings>) => onSettings({ ...settings, ...patch });
  return (
    <section className="ev-card ev-b-plan" data-evb-plan={plan ? "priced" : pending ? "pricing" : "none"} aria-busy={pending}>
      <h2>
        <VerdictGlyph state="dry" size={11} />
        The plan
      </h2>

      <div className="ev-b-plan-row">
        <span className="ev-b-label">Tier 1 render classes</span>
        {!plan ? (
          <span className="ev-b-pending">{error ? `Could not plan: ${error}` : "Reading the candidates..."}</span>
        ) : plan.classes === null ? (
          <span className="ev-b-pending" data-evb-classes="unrendered">
            Not rendered yet: Start renders each candidate dry first (free, a few minutes), so until then each of the {plural(plan.candidates.length, "candidate")} counts as its own class.
          </span>
        ) : (
          <span className="ev-b-classes" data-evb-classes={plan.classes.length}>
            {plan.classes.map((k) => (
              <span key={k.n} className="ev-chip" title={k.skip ?? `${k.shas.length} ${k.shas.length === 1 ? "commit renders" : "commits render"} alike; a probe replays ${shortSha(k.representative)}`} style={k.skip ? { textDecoration: "line-through" } : undefined}>
                class {k.n}
                {k.shas.length > 1 ? `, ${k.shas.length} alike` : ""}
              </span>
            ))}
          </span>
        )}
      </div>

      <div className="ev-b-plan-row">
        <span className="ev-b-label">Freezes</span>
        {freezeOptions.map((f) => (
          <label key={f.id} className="ev-b-freeze">
            <input
              type="checkbox"
              checked={settings.freezes.includes(f.id)}
              onChange={(e) => set({ freezes: e.target.checked ? [...settings.freezes, f.id] : settings.freezes.filter((x) => x !== f.id) })}
            />
            <span className="ev-mono ev-small">{f.name}</span>
            <span className="ev-b-freeze-role" data-role={f.role}>
              {f.role === "flipped" ? "flipped" : "stable control"}
            </span>
          </label>
        ))}
      </div>

      <div className="ev-b-plan-row">
        <span className="ev-b-label">Reps per probe</span>
        <span className="ev-b-start">
          <SegmentedToggle value={String(settings.reps)} onChange={(k) => set({ reps: Number(k) })} items={PLAN_REPS.map((r) => ({ key: String(r), label: String(r) }))} />
        </span>
      </div>

      <div className="ev-b-nums">
        <div className="ev-b-field">
          <label htmlFor="ev-b-budget">Budget, USD</label>
          <input id="ev-b-budget" className="ev-b-input" type="number" min={0} step={0.1} placeholder={plan ? plan.budgetUsd.toFixed(2) : ""} value={settings.budgetUsd ?? ""} onChange={(e) => set({ budgetUsd: numberOrNull(e.target.value) })} />
        </div>
        <div className="ev-b-field">
          <label htmlFor="ev-b-minutes">Max minutes</label>
          <input id="ev-b-minutes" className="ev-b-input" type="number" min={1} step={5} placeholder={plan ? String(plan.maxMinutes) : ""} value={settings.maxMinutes ?? ""} onChange={(e) => set({ maxMinutes: numberOrNull(e.target.value) })} />
        </div>
      </div>

      {settings.allCommits && (
        <div className="ev-b-plan-row" data-evb-all-commits>
          <span className="ev-b-label">Commits</span>
          <span className="ev-small">Every commit in the range, not only the ones touching declared sources (--all-commits).</span>
        </div>
      )}

      {plan && (
        <div className="ev-b-cost" data-evb-cost style={pending ? { opacity: 0.55 } : undefined}>
          {plan.summary}
          <div className="ev-b-cost-figs">
            <span>
              <b>{plan.bound.classes}</b>
              {plan.bound.classes === 1 ? "class" : "classes"}
            </span>
            <span>
              <b>{plan.bound.probes}</b>
              {plan.bound.probes === 1 ? "probe" : "probes"}
            </span>
            <span>
              <b>{plan.bound.maxReps}</b>reps at most
            </span>
            <span>
              <b>{usd(plan.bound.maxUsd)}</b>at most
            </span>
          </div>
        </div>
      )}
      {over && plan && (
        <div className="ev-b-over" role="alert">
          The bound ({usd(plan.bound.maxUsd)}) is over the budget ({usd(settings.budgetUsd ?? plan.budgetUsd)}), and the bisect would refuse to start. Raise the budget or cut freezes or reps.
        </div>
      )}

      {plan?.needsConfirm && (
        <label className="ev-b-confirm" data-evb-confirm>
          <input type="checkbox" checked={confirm} onChange={(e) => onConfirm(e.target.checked)} />
          <span>
            {plan.surface} is an agent surface: every rep runs a whole agent session, at about {usd(plan.bound.perRepUsd + plan.bound.judgePerRepUsd)} a rep. Start it anyway.
          </span>
        </label>
      )}

      {blockedBy && (
        <div className="ev-b-lock" role="status" data-evb-blocked={blockedBy.id}>
          <span className="ev-b-lock-dot" aria-hidden />
          <span>
            {blockedBy.listed ? (
              <EvalsLink className="ev-b-link" href={href.bisect(blockedBy.id)}>
                {blockedBy.id}
              </EvalsLink>
            ) : (
              <span className="ev-mono">{blockedBy.id}</span>
            )}
            {blockedBy.surface ? ` (${blockedBy.surface})` : ""} holds the machine. One bisect runs at a time, so Start waits until it finishes or is stopped.
            {!blockedBy.listed && " These pages cannot open it (a Multiplayer sim bisect, say); read or stop it from the checkout:"}
          </span>
          {!blockedBy.listed && (
            <span className="ev-b-lock-cmds">
              <CopyCommand command={`./evals bisect status ${blockedBy.id}`} />
              <CopyCommand command={`./evals bisect stop ${blockedBy.id}`} label="Copy stop" />
            </span>
          )}
        </div>
      )}

      <div className="ev-b-start-row">
        <button type="button" className="ev-btn ev-btn--lg ev-btn--go" disabled={!go} onClick={onStart} data-evb-start title={blockedBy ? `${blockedBy.id} is running; one bisect runs at a time` : undefined}>
          {starting ? "Starting..." : "Start the bisect"}
          {keys.map((k) => (
            <KeyCap key={k} size="xs">
              {k}
            </KeyCap>
          ))}
        </button>
        {plan && <span className="ev-b-fine ev-quiet">Spends up to {usd(settings.budgetUsd ?? plan.budgetUsd)}, stops between reps when it is gone.</span>}
      </div>
      {startError && (
        <div className="ev-b-over" role="alert">
          Could not start: {startError}
        </div>
      )}
    </section>
  );
}
