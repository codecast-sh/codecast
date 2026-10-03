// The compare drawer (docs/architecture/evals-ui.md 4.2): two pinned batches
// side by side. The later one is weighed against the earlier with the one
// verdict the CLI prints (GET /batches answers verdict.ts batchVerdict), then
// the gates that newly fail, the freezes that flipped as before and after
// pairs, and what the model saw before and after on one flipped freeze.

import { useState } from "react";
import { X } from "lucide-react";
import type { BatchStats, BatchesResponse, EvalRoute } from "@codecast/shared/contracts/evalsApi";
import { ExamplePair } from "../decisions/ChangeCardView";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { EvalsLink, FlipRunLinks, LockBadge, PromptDiff, SeparationMark, VerdictGlyph, batchLabel, flipFreezeHref, score2, shortModel, usd, verdictOfSet } from "./parts";
import { evalsHref } from "./evalsPaths";
import { ChangedPrompts } from "./EpochDiffSheet";

export interface ComparePanelProps {
  surface: string;
  route: EvalRoute;
  /** The earlier batch (the baseline) and the later one. */
  a: BatchStats;
  b: BatchStats;
  res: BatchesResponse | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}


/** The prompt files a surface's reps write, for a freeze the answer did not diff. */
const promptFiles = (route: EvalRoute) => (route === "agent" ? ["agent1/prompt.md", "agent1/then2.md"] : ["call1/system.md", "call1/prompt.md"]);

function SetColumn({ label, set }: { label: string; set: BatchStats }) {
  return (
    <div className="ev-sf-set" data-ev-set={label}>
      <div className="ev-sf-set-head">
        <span className="ev-sf-pinmark">{label}</span>
        <VerdictGlyph state={verdictOfSet(set.passed, set.reps)} />
        <span className="ev-tabular">{batchLabel(set.batch, set.batchAt)}</span>
      </div>
      <div className="ev-sf-set-num ev-tabular">{score2(set.median)}</div>
      <dl className="ev-sf-set-facts">
        <dt>reps</dt>
        <dd>{set.reps}</dd>
        <dt>passed</dt>
        <dd>{set.passed}</dd>
        <dt>cost</dt>
        <dd>{usd(set.costUsd + set.judgeCostUsd)}</dd>
      </dl>
      <div className="ev-sf-set-foot ev-quiet" title={set.footing.ruler ?? undefined}>
        {shortModel(set.footing.model)}
        {set.cadence ? `, ${set.cadence}` : ", by hand"}
      </div>
    </div>
  );
}

export function ComparePanel({ surface, route, a, b, res, loading, error, onClose }: ComparePanelProps) {
  const [freezeIdx, setFreezeIdx] = useState(0);
  const flips = res?.flips.ok ? res.flips.flips : [];
  const pick = flips[Math.min(freezeIdx, flips.length - 1)] ?? null;
  const files = res?.promptDiffs.length ? [...new Set(res.promptDiffs.map((p) => p.file))] : promptFiles(route);
  const newlyFailing = (res?.gateDeltas ?? []).filter((g) => g.b > g.a);
  const v = res?.verdict ?? null;
  return (
    <aside className="ev-sf-compare ev-card" aria-label="Compare two batches" data-ev-compare>
      <header className="ev-sf-compare-head">
        <span className="ev-title">
          <SeparationMark result={v?.separation ?? null} />
          Compare two batches
        </span>
        <button type="button" className="ev-sf-iconbtn" onClick={onClose} aria-label="Close the comparison">
          <X className="w-3.5 h-3.5" />
        </button>
      </header>

      <div className="ev-sf-sets">
        <SetColumn label="1" set={a} />
        <SetColumn label="2" set={b} />
      </div>

      {error ? (
        <p className="ev-sf-note ev-fail">{error}</p>
      ) : !res ? (
        <p className="ev-sf-note ev-quiet">{loading ? "Weighing the second against the first..." : "Pin two batches to compare them."}</p>
      ) : (
        <>
          <section className="ev-sf-verdict" data-ev-compare-verdict={v?.separation.kind}>
            <SeparationMark result={v?.separation ?? null} showWord size={14} />
            <span className="ev-quiet ev-tabular" title="One-sided Mann-Whitney of batch 2's scores against batch 1's alone">
              {v ? `${v.compared.current.length} reps against ${v.compared.previous.length}, against batch 1 alone` : ""}
            </span>
          </section>

          {newlyFailing.length > 0 && (
            <section className="ev-sf-section" data-ev-compare-gates>
              <h4 className="ev-title">
                <VerdictGlyph state="fail" size={10} /> Gates failing more often
              </h4>
              <ul className="ev-sf-gates">
                {newlyFailing.map((g) => (
                  <li key={g.id}>
                    <span className="ev-chip ev-gate">{g.id}</span>
                    <span className="ev-tabular ev-quiet">
                      {g.a} then {g.b} {g.b === 1 ? "rep" : "reps"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="ev-sf-section" data-ev-compare-flips>
            <h4 className="ev-title">
              <VerdictGlyph state={flips.some((f) => f.direction === "broke") ? "mixed" : "pass"} size={10} />
              {res.flips.ok ? (flips.length ? `${flips.length} ${flips.length === 1 ? "freeze" : "freezes"} flipped` : "No freeze flipped") : "Flips not compared"}
            </h4>
            {!res.flips.ok ? (
              <p className="ev-sf-note ev-quiet">{res.flips.reason}</p>
            ) : (
              <div className="ev-sf-examples cc-inline">
                {res.examples.map((ex) => {
                  const f = flips.find((x) => x.freezeId === ex.freeze);
                  return (
                    <div key={ex.freeze} className="ev-sf-example" data-ev-example={ex.direction}>
                      <div className="ev-sf-example-head">
                        <span className={ex.direction === "broke" ? "ev-fail" : "ev-pass"}>{ex.direction}</span>
                        <EvalsLink href={f ? flipFreezeHref(f) : evalsHref.freeze(ex.freeze)} className="ev-sf-example-name">
                          {ex.name}
                        </EvalsLink>
                        {f && <LockBadge visibility={f.visibility} />}
                        {f && <FlipRunLinks flip={f} />}
                      </div>
                      <ExamplePair ex={ex} />
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {pick && (
            <section className="ev-sf-section" data-ev-compare-prompt>
              <h4 className="ev-title">
                What the model saw
                {flips.length > 1 && (
                  <select className="ev-sf-select" value={Math.min(freezeIdx, flips.length - 1)} onChange={(e) => setFreezeIdx(Number(e.target.value))} aria-label="Freeze to diff">
                    {flips.map((f, i) => (
                      <option key={f.freezeId} value={i}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                )}
              </h4>
              {freezeIdx === 0 && res.promptDiffs.length
                ? <ChangedPrompts pairs={res.promptDiffs} />
                : pick.before[0] && pick.after[0]
                  ? files.map((file) => <PromptDiff key={`${pick.freezeId}:${file}`} a={pick.before[0]} b={pick.after[0]} file={file} />)
                  : <p className="ev-sf-note ev-quiet">No rep on one side to diff.</p>}
            </section>
          )}
        </>
      )}

      <footer className="ev-sf-compare-foot">
        <EvalsLink href={evalsHref.bisectNew({ surface, good: a.batch, bad: b.batch })} className="ev-sf-btn ev-sf-btn--primary" data-ev-attribute>
          Attribute this
          <KeyCap size="xs">b</KeyCap>
        </EvalsLink>
      </footer>
    </aside>
  );
}
