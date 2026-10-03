// The commit ruler (docs/architecture/evals-ui.md 4.5): candidate commits as
// tiles in ancestry order, tiles that render alike bracketed together, the
// uncommitted patch hatched at the end, and the two controls at either end.
// The good and bad brackets slide inward as probes resolve; each probed tile
// grows a column of wells, one per rep per freeze, that fill as reps land.
// The culprit lifts out of the ruler. Props only: the geometry is fixed
// widths, so it needs no measuring and draws the same in a background tab.

import { useLayoutEffect, useRef, type CSSProperties } from "react";
import type { BisectPlan, BisectProbe, BisectRep, BisectState } from "@codecast/shared/contracts/evalsApi";
import { EntityIdPill } from "../EntityIdPill";
import { Well } from "./charts/Well";
import { EvalsLink, VerdictGlyph, shortSha, type VerdictState } from "./parts";
import { rulerModel, type RulerModel, type RulerTile } from "./bisectModel";
import { evalsHref } from "./evalsPaths";
import "./bisect.css";

const W = 124;
const CW = 84;
const GAP = 12;

/** Where tile i starts inside the row (the good control column sits before it). */
const tileLeft = (i: number) => CW + GAP + i * (W + GAP);

const PROBE_WORDS: Record<BisectProbe["kind"], string> = { "control-good": "good control", "control-bad": "bad control", probe: "probe", "confirm-culprit": "confirm", "confirm-parent": "parent" };

const verdictGlyph = (v: RulerTile["verdict"]): VerdictState => (v === "good" ? "pass" : v === "bad" ? "fail" : v === "unsure" ? "mixed" : v === "pending" ? "unscored" : "dry");

/** One probe's reps as wells: a row per freeze, a well per rep, empty until the rep lands. */
function ProbeWells({ probe, freezes, delayFrom = 0 }: { probe: BisectProbe; freezes: BisectPlan["freezes"]; delayFrom?: number }) {
  const byFreeze = new Map<string, BisectRep[]>();
  for (const r of probe.reps) byFreeze.set(r.freezeId, [...(byFreeze.get(r.freezeId) ?? []), r]);
  const landed = probe.reps.filter((r) => r.passed !== null).length;
  let k = delayFrom;
  return (
    <div className="evb-wells" data-evb-wells={probe.kind} data-evb-landed={landed}>
      <div className="evb-wells-label">
        <span>{probe.recorded ? "recorded" : PROBE_WORDS[probe.kind]}</span>
        <span className="ev-tabular">
          {landed}/{probe.reps.length}
        </span>
      </div>
      {freezes.map((f) => {
        const reps = byFreeze.get(f.id);
        if (!reps?.length) return null;
        return (
          <div key={f.id} className="evb-wells-row" data-role={f.role}>
            {reps.map((r, i) => {
              const title = r.passed === null ? `${f.name}, rep ${i + 1}: not landed yet` : `${f.name}, rep ${i + 1}: ${r.passed ? "passed" : "failed"}, ${r.score?.toFixed(2) ?? "no score"}`;
              const well = <Well key={i} size={11} cell={r.passed === null ? null : { reps: 1, mean: r.score, majority: r.passed, flip: null }} title={title} delayMs={r.passed === null ? undefined : (k++ % 40) * 12} />;
              return r.runId ? (
                <EvalsLink key={i} href={evalsHref.run(r.runId)} aria-label={title}>
                  {well}
                </EvalsLink>
              ) : (
                well
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function ControlColumn({ side, sha, probes, freezes, spaced }: { side: "good" | "bad"; sha: string; probes: BisectProbe[]; freezes: BisectPlan["freezes"]; spaced: boolean }) {
  const reading = probes.find((p) => p.kind === `control-${side}`)?.verdict ?? null;
  const reproduced = reading === null || reading === "pending" || reading === side;
  return (
    <div className="evb-col evb-col--control" data-evb-control={side}>
      <div className="evb-tile evb-tile--control" data-verdict={reading ?? undefined} style={!reproduced ? { borderColor: "var(--sol-violet)", borderStyle: "solid" } : undefined}>
        <VerdictGlyph state={verdictGlyph(reading)} size={12} title={reading ? `${side} control: ${reading}` : `${side} control not run yet`} />
        <span>{side} end</span>
        <span className="ev-mono">{shortSha(sha)}</span>
      </div>
      {spaced && <div className="evb-col-spacer" aria-hidden />}
      {probes.map((p, i) => (
        <ProbeWells key={`${p.kind}:${i}`} probe={p} freezes={freezes} />
      ))}
    </div>
  );
}

function Tile({ tile, freezes, stalled, spaced }: { tile: RulerTile; freezes: BisectPlan["freezes"]; stalled: boolean; spaced: boolean }) {
  const c = tile.candidate;
  return (
    <div className="evb-col" data-outside={tile.outside || undefined} data-evb-tile={tile.key}>
      <div
        className={`evb-tile ${c.kind === "patch" ? "evb-tile--patch" : ""} ${tile.culprit ? "evb-tile--culprit" : ""}`}
        data-verdict={tile.verdict ?? undefined}
        title={c.kind === "commit" ? `${c.commit.sha}\n${c.commit.subject}\n${c.commit.author}` : `Uncommitted edits on top of ${c.base}, kept as trees/${c.treePatch}.patch`}
      >
        <span className="evb-tile-sha">{c.kind === "commit" ? shortSha(c.commit.sha) : `edits+${shortSha(c.base, 6)}`}</span>
        {tile.verdict && (
          <span className={`evb-tile-verdict ${tile.verdict === "pending" && !stalled ? "ev-pulse" : ""}`}>
            <VerdictGlyph state={verdictGlyph(tile.verdict)} size={11} title={tile.verdict} />
          </span>
        )}
        <span className="evb-tile-subject">{c.kind === "commit" ? c.commit.subject : "Uncommitted edits the bad end ran"}</span>
        <span className="evb-tile-foot">
          {tile.culprit ? (
            <span className="evb-tag evb-tag--culprit">culprit</span>
          ) : tile.recorded ? (
            <span className="evb-tag" title="Read for free from a recorded batch">recorded</span>
          ) : null}
          {c.kind === "commit" && !c.commit.onMain && <span className="evb-tag" title={c.commit.mainSha ? `main twin ${c.commit.mainSha}` : "no main twin"}>off-branch</span>}
          {c.kind === "commit" && c.commit.session && <EntityIdPill type="session" id={c.commit.session} compact />}
        </span>
      </div>
      {spaced && <div className="evb-col-spacer" aria-hidden />}
      {tile.probes.map((p, i) => (
        <ProbeWells key={`${p.kind}:${i}`} probe={p} freezes={freezes} />
      ))}
    </div>
  );
}

export function BisectRuler({ state, stalled = false, model: given }: { state: BisectState; stalled?: boolean; model?: RulerModel }) {
  const model = given ?? rulerModel(state);
  const freezes = state.plan.freezes;
  const goodX = model.goodAt < 0 ? tileLeft(0) - GAP / 2 - 5 : tileLeft(model.goodAt) + W + GAP / 2 - 5;
  const badX = tileLeft(model.badAt) + W + GAP / 2 - 4;
  const vars = { "--evb-w": `${W}px`, "--evb-cw": `${CW}px`, "--evb-gap": `${GAP}px` } as CSSProperties;
  const multi = model.spans.filter((s) => s.to > s.from || s.skip);
  const spaced = multi.length > 0;
  // A long range opens on its brackets, not on the tiles already known good.
  // Setting scrollLeft needs no layout read, so this works in a background tab too.
  const wrap = useRef<HTMLDivElement>(null);
  const focusX = Math.max(0, (model.culpritAt !== null ? tileLeft(model.culpritAt) : goodX) - W);
  useLayoutEffect(() => {
    if (wrap.current) wrap.current.scrollLeft = focusX;
  }, [focusX]);
  return (
    <div ref={wrap} className="evb-ruler-wrap ev-bench" data-evb-ruler data-evb-good-at={model.goodAt} data-evb-bad-at={model.badAt}>
      <div className="evb-ruler" style={vars}>
        <div className="evb-ruler-row">
          <ControlColumn side="good" sha={state.range.good} probes={model.controls.good} freezes={freezes} spaced={spaced} />
          {model.tiles.map((t) => (
            <Tile key={t.key} tile={t} freezes={freezes} stalled={stalled} spaced={spaced} />
          ))}
          <ControlColumn side="bad" sha={state.range.bad} probes={model.controls.bad} freezes={freezes} spaced={spaced} />
          {model.tiles.length > 0 && (
            <>
              <span className="evb-bracket evb-bracket--good" style={{ left: 0, transform: `translateX(${goodX}px)` }} aria-hidden>
                <span className="evb-bracket-label">good</span>
              </span>
              <span className="evb-bracket evb-bracket--bad" style={{ left: 0, transform: `translateX(${badX}px)` }} aria-hidden>
                <span className="evb-bracket-label">bad</span>
              </span>
            </>
          )}
        </div>
        {multi.length > 0 && (
          <div className="evb-spans" style={{ position: "absolute", left: 16, right: 16, top: 26 + 92 + 3 }} aria-hidden>
            {multi.map((s) => (
              <span key={s.n} className="evb-span" data-skip={s.skip ? "" : undefined} style={{ left: tileLeft(s.from), width: (s.to - s.from + 1) * W + (s.to - s.from) * GAP }} title={s.skip ?? undefined}>
                <span className="evb-span-label">{s.skip ? `class ${s.n} does not load` : `class ${s.n}: renders alike`}</span>
              </span>
            ))}
          </div>
        )}
        {model.tiles.length === 0 && <div className="evb-note px-1 pt-3">No candidate commits: the range holds nothing to search.</div>}
      </div>
    </div>
  );
}
