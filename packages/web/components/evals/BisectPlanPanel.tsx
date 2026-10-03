// The priced plan (docs/architecture/evals-ui.md 4.5, section 5): shown only
// when the free answer narrowed the range without pinning it. It carries the
// Tier 1 render classes, the freeze set (the flipped freezes plus two stable
// controls), reps, budget and time, and the cost bound in plain words. The
// engine prices every change (POST /bisect/plan), so the bound shown is the
// one `check --budget` will enforce. Agent surfaces ask for a confirm.

import type { BisectPlan } from "@codecast/shared/contracts/evalsApi";
import { formatShortcutParts, getShortcutsForAction } from "../../shortcuts";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { SegmentedToggle } from "../SegmentedToggle";
import { VerdictGlyph, shortSha, usd } from "./parts";
import "./bisect.css";

export interface PlanSettings {
  freezes: string[];
  reps: number;
  /** null: the engine's default, 1.2 times the bound. */
  budgetUsd: number | null;
  maxMinutes: number | null;
  allCommits: boolean;
}

export const PLAN_REPS = [3, 4, 5, 6, 7] as const;

/** Over budget: `check --budget` refuses a plan whose bound is above it. */
export const planOverBudget = (plan: BisectPlan, budgetUsd: number | null) => (budgetUsd ?? plan.budgetUsd) < plan.bound.maxUsd;

/** The keys Start answers to, as the shortcut registry names them. */
export function startKeys(): string[] {
  const defs = getShortcutsForAction("list.open");
  return defs.length ? formatShortcutParts(defs[0]) : [];
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
  /** No declared source moved: offer --all-commits. */
  offerAllCommits: boolean;
  confirm: boolean;
  onConfirm: (v: boolean) => void;
  starting: boolean;
  startError: string | null;
  onStart: () => void;
}

/** Whether Start can go: a priced plan for these settings, within budget, confirmed where it must be. */
export function canStart(p: Pick<BisectPlanPanelProps, "plan" | "pending" | "starting" | "confirm" | "settings">): boolean {
  if (!p.plan || p.pending || p.starting || !p.settings.freezes.length) return false;
  if (p.plan.needsConfirm && !p.confirm) return false;
  return !planOverBudget(p.plan, p.settings.budgetUsd);
}

function numberOrNull(v: string): number | null {
  const n = Number(v);
  return v.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : n;
}

export function BisectPlanPanel(props: BisectPlanPanelProps) {
  const { plan, pending, error, freezeOptions, settings, onSettings, offerAllCommits, confirm, onConfirm, starting, startError, onStart } = props;
  const over = plan ? planOverBudget(plan, settings.budgetUsd) : false;
  const go = canStart(props);
  const keys = startKeys();
  const set = (patch: Partial<PlanSettings>) => onSettings({ ...settings, ...patch });
  return (
    <section className="ev-card evb-plan" data-evb-plan={plan ? "priced" : pending ? "pricing" : "none"} aria-busy={pending}>
      <h2>
        <VerdictGlyph state="dry" size={11} />
        The plan
      </h2>

      <div className="evb-plan-row">
        <span className="evb-label">Tier 1 render classes</span>
        {!plan ? (
          <span className="evb-pending">{error ? `Could not plan: ${error}` : "Reading the candidates..."}</span>
        ) : plan.classes === null ? (
          <span className="evb-pending">
            <span className="ev-pulse">Dry rendering each candidate (free, a few minutes).</span>
          </span>
        ) : (
          <span className="evb-classes" data-evb-classes={plan.classes.length}>
            {plan.classes.map((k) => (
              <span key={k.n} className="ev-chip" title={k.skip ?? `${k.shas.length} ${k.shas.length === 1 ? "commit renders" : "commits render"} alike; a probe replays ${shortSha(k.representative)}`} style={k.skip ? { textDecoration: "line-through" } : undefined}>
                class {k.n}
                {k.shas.length > 1 ? `, ${k.shas.length} alike` : ""}
              </span>
            ))}
          </span>
        )}
      </div>

      <div className="evb-plan-row">
        <span className="evb-label">Freezes</span>
        {freezeOptions.map((f) => (
          <label key={f.id} className="evb-freeze">
            <input
              type="checkbox"
              checked={settings.freezes.includes(f.id)}
              onChange={(e) => set({ freezes: e.target.checked ? [...settings.freezes, f.id] : settings.freezes.filter((x) => x !== f.id) })}
            />
            <span className="ev-mono text-[12px]">{f.name}</span>
            <span className="evb-freeze-role" data-role={f.role}>
              {f.role === "flipped" ? "flipped" : "stable control"}
            </span>
          </label>
        ))}
      </div>

      <div className="evb-plan-row">
        <span className="evb-label">Reps per probe</span>
        <span className="self-start">
          <SegmentedToggle value={String(settings.reps)} onChange={(k) => set({ reps: Number(k) })} items={PLAN_REPS.map((r) => ({ key: String(r), label: String(r) }))} />
        </span>
      </div>

      <div className="evb-nums">
        <div className="evb-field">
          <label htmlFor="evb-budget">Budget, USD</label>
          <input id="evb-budget" className="evb-input" type="number" min={0} step={0.1} placeholder={plan ? plan.budgetUsd.toFixed(2) : ""} value={settings.budgetUsd ?? ""} onChange={(e) => set({ budgetUsd: numberOrNull(e.target.value) })} />
        </div>
        <div className="evb-field">
          <label htmlFor="evb-minutes">Max minutes</label>
          <input id="evb-minutes" className="evb-input" type="number" min={1} step={5} placeholder={plan ? String(plan.maxMinutes) : ""} value={settings.maxMinutes ?? ""} onChange={(e) => set({ maxMinutes: numberOrNull(e.target.value) })} />
        </div>
      </div>

      {offerAllCommits && (
        <label className="evb-freeze">
          <input type="checkbox" checked={settings.allCommits} onChange={(e) => set({ allCommits: e.target.checked })} />
          <span>Search every commit in the range, not only the ones touching declared sources</span>
        </label>
      )}

      {plan && (
        <div className="evb-cost" data-evb-cost style={pending ? { opacity: 0.55 } : undefined}>
          {plan.summary}
          <div className="evb-cost-figs">
            <span>
              <b>{plan.bound.classes}</b>classes
            </span>
            <span>
              <b>{plan.bound.probes}</b>probes
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
        <div className="evb-over" role="alert">
          The bound ({usd(plan.bound.maxUsd)}) is over the budget ({usd(settings.budgetUsd ?? plan.budgetUsd)}), and the bisect would refuse to start. Raise the budget or cut freezes or reps.
        </div>
      )}

      {plan?.needsConfirm && (
        <label className="evb-confirm" data-evb-confirm>
          <input type="checkbox" checked={confirm} onChange={(e) => onConfirm(e.target.checked)} />
          <span>
            {plan.surface} is an agent surface: every rep runs a whole agent session, at about {usd(plan.bound.perRepUsd + plan.bound.judgePerRepUsd)} a rep. Start it anyway.
          </span>
        </label>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <button type="button" className="evb-btn evb-btn--go" disabled={!go} onClick={onStart} data-evb-start>
          {starting ? "Starting..." : "Start the bisect"}
          {keys.map((k) => (
            <KeyCap key={k} size="xs">
              {k}
            </KeyCap>
          ))}
        </button>
        {plan && <span className="text-[11.5px] ev-quiet">Spends up to {usd(settings.budgetUsd ?? plan.budgetUsd)}, stops between reps when it is gone.</span>}
      </div>
      {startError && (
        <div className="evb-over" role="alert">
          Could not start: {startError}
        </div>
      )}
    </section>
  );
}
