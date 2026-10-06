// The commit ruler (docs/architecture/evals-ui.md 4.5): candidate commits as
// tiles in ancestry order, tiles that render alike bracketed together, the
// uncommitted patch hatched at the end, and the two controls at either end.
// The good and bad brackets slide inward as probes resolve; each probed tile
// grows a column of wells, one per rep per freeze, that fill as reps land.
// The culprit lifts out of the ruler. Props only: the geometry is fixed
// widths, so it needs no measuring and draws the same in a background tab.

import { useLayoutEffect, useRef, type CSSProperties } from "react";
import type { BisectPlan, BisectProbe, BisectRep, BisectState } from "@codecast/shared/contracts/evalsApi";
import { Well } from "./charts/Well";
import { useCommitSession } from "./CommitPanel";
import { EvalsLink, VerdictGlyph } from "./parts";
import { endpointLabel, repState, repTally, rulerModel, type RulerModel, type RulerTile, offBranchWords, shortSha, type VerdictState } from "@platform/evals/client";
import { evalsHref } from "./evalsPaths";
import { useEvalsHost } from "./host";

const W = 124;
/** The control column: wide enough that "good control" and "bad control" each sit on one line, so both cards line up. */
const CW = 92;
const GAP = 12;

/** Where tile i starts inside the row (the good control column sits before it). */
const tileLeft = (i: number) => CW + GAP + i * (W + GAP);

const PROBE_WORDS: Record<BisectProbe["kind"], string> = { "control-good": "good control", "control-bad": "bad control", probe: "probe", "confirm-culprit": "confirm", "confirm-parent": "parent" };

const verdictGlyph = (v: RulerTile["verdict"]): VerdictState => (v === "good" ? "pass" : v === "bad" ? "fail" : v === "unsure" ? "mixed" : v === "pending" ? "unscored" : "dry");

/** One probe's reps as wells: a row per freeze, a well per rep, empty until the rep lands. */
function ProbeWells({ probe, freezes, delayFrom = 0 }: { probe: BisectProbe; freezes: BisectPlan["freezes"]; delayFrom?: number }) {
  const byFreeze = new Map<string, BisectRep[]>();
  for (const r of probe.reps) byFreeze.set(r.freezeId, [...(byFreeze.get(r.freezeId) ?? []), r]);
  const { landed, all, passed, failed, crashed } = repTally(probe.reps);
  let k = delayFrom;
  return (
    <div className="ev-b-wells" data-evb-wells={probe.kind} data-evb-landed={landed}>
      <div className="ev-b-wells-label" title={`${landed} of ${all} reps landed${landed ? `: ${passed} passed, ${failed} failed${crashed ? `, ${crashed} crashed` : ""}` : ""}. Rows: f a flipped freeze, c a stable control.`}>
        <span>{probe.recorded ? "recorded" : PROBE_WORDS[probe.kind]}</span>
        <span className="ev-b-wells-tally ev-tabular" data-evb-tally={landed === all ? "landed" : "landing"}>
          {landed < all ? (
            `${landed} of ${all} landed`
          ) : (
            <>
              <span className="ev-pass">{passed} pass</span>{" "}
              <span className={failed ? "ev-fail" : undefined}>{failed} fail</span>
              {crashed > 0 && <>{" "}<span className="ev-b-wells-crashed">{crashed} crashed</span></>}
            </>
          )}
        </span>
      </div>
      {freezes.map((f) => {
        const reps = byFreeze.get(f.id);
        if (!reps?.length) return null;
        return (
          <div key={f.id} className="ev-b-wells-row" data-role={f.role}>
            <span className="ev-b-wells-role" title={f.role === "flipped" ? `${f.name}: a flipped freeze` : `${f.name}: a stable control`} aria-hidden>
              {f.role === "flipped" ? "f" : "c"}
            </span>
            {reps.map((r, i) => {
              const state = repState(r);
              const title =
                state === "pending" ? `${f.name}, rep ${i + 1}: not landed yet` : state === "crashed" ? `${f.name}, rep ${i + 1}: crashed, no score; open the run for its log` : `${f.name}, rep ${i + 1}: ${state}, ${r.score?.toFixed(2) ?? "no score"}`;
              const well =
                state === "crashed" ? (
                  <span key={i} className="ev-b-well-crash" data-evb-rep="crashed">
                    <VerdictGlyph state="crash" size={11} title={title} />
                  </span>
                ) : (
                  <Well key={i} size={11} cell={r.passed === null ? null : { reps: 1, mean: r.score, majority: r.passed, flip: null }} title={title} delayMs={r.passed === null ? undefined : (k++ % 40) * 12} />
                );
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
    <div className="ev-b-col ev-b-col--control" data-evb-control={side}>
      <div className="ev-b-tile ev-b-tile--control" data-verdict={reading ?? undefined} style={!reproduced ? { borderColor: "var(--ev-violet)", borderStyle: "solid" } : undefined}>
        <VerdictGlyph state={verdictGlyph(reading)} size={12} title={reading ? `${side} control: ${reading}` : `${side} control not run yet`} />
        <span>{side} end</span>
        {/* A batch name or a sha: the range holds whichever the bisect was started with. */}
        <span className="ev-mono">{endpointLabel(sha)}</span>
      </div>
      {spaced && <div className="ev-b-col-spacer" aria-hidden />}
      {probes.map((p, i) => (
        <ProbeWells key={`${p.kind}:${i}`} probe={p} freezes={freezes} />
      ))}
    </div>
  );
}

function Tile({ tile, freezes, stalled, spaced }: { tile: RulerTile; freezes: BisectPlan["freezes"]; stalled: boolean; spaced: boolean }) {
  const c = tile.candidate;
  const { SessionPill } = useEvalsHost().ui;
  const session = useCommitSession(c.kind === "commit" ? c.commit : { session: null });
  return (
    <div className="ev-b-col" data-outside={tile.outside || undefined} data-evb-tile={tile.key}>
      <div
        className={`ev-b-tile ${c.kind === "patch" ? "ev-b-tile--patch" : ""} ${tile.culprit ? "ev-b-tile--culprit" : ""}`}
        data-verdict={tile.verdict ?? undefined}
        title={c.kind === "commit" ? `${c.commit.sha}\n${c.commit.subject}\n${c.commit.author}` : `Uncommitted edits on top of ${c.base}, kept as trees/${c.treePatch}.patch`}
      >
        <span className="ev-b-tile-sha">{c.kind === "commit" ? shortSha(c.commit.sha) : `edits+${shortSha(c.base, 6)}`}</span>
        {tile.verdict && (
          <span className={`ev-b-tile-verdict ${tile.verdict === "pending" && !stalled ? "ev-pulse" : ""}`}>
            <VerdictGlyph state={verdictGlyph(tile.verdict)} size={11} title={tile.verdict} />
          </span>
        )}
        <span className="ev-b-tile-subject">{c.kind === "commit" ? c.commit.subject : "Uncommitted edits the bad end ran"}</span>
        <span className="ev-b-tile-foot">
          {tile.culprit ? (
            <span className="ev-b-tag ev-b-tag--culprit">culprit</span>
          ) : tile.recorded ? (
            <span className="ev-b-tag" title="Read for free from a recorded batch">recorded</span>
          ) : null}
          {c.kind === "commit" && !c.commit.onMain && <span className="ev-b-tag" title={offBranchWords(c.commit).title}>off-branch</span>}
          {session && (
            <span className="ev-b-tile-session">
              <SessionPill id={session} />
            </span>
          )}
        </span>
      </div>
      {spaced && <div className="ev-b-col-spacer" aria-hidden />}
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
  const vars = { "--ev-b-w": `${W}px`, "--ev-b-cw": `${CW}px`, "--ev-b-gap": `${GAP}px` } as CSSProperties;
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
    <div ref={wrap} className="ev-b-ruler-wrap ev-bench" data-evb-ruler data-evb-good-at={model.goodAt} data-evb-bad-at={model.badAt}>
      <div className="ev-b-ruler" style={vars}>
        <div className="ev-b-ruler-row">
          <ControlColumn side="good" sha={state.range.good} probes={model.controls.good} freezes={freezes} spaced={spaced} />
          {model.tiles.map((t) => (
            <Tile key={t.key} tile={t} freezes={freezes} stalled={stalled} spaced={spaced} />
          ))}
          <ControlColumn side="bad" sha={state.range.bad} probes={model.controls.bad} freezes={freezes} spaced={spaced} />
          {model.tiles.length > 0 && (
            <>
              <span className="ev-b-bracket ev-b-bracket--good" style={{ left: 0, transform: `translateX(${goodX}px)` }} aria-hidden>
                <span className="ev-b-bracket-label">good</span>
              </span>
              <span className="ev-b-bracket ev-b-bracket--bad" style={{ left: 0, transform: `translateX(${badX}px)` }} aria-hidden>
                <span className="ev-b-bracket-label">bad</span>
              </span>
            </>
          )}
        </div>
        {multi.length > 0 && (
          <div className="ev-b-spans" style={{ position: "absolute", left: 16, right: 16, top: 30 + 92 + 3 }} aria-hidden>
            {multi.map((s) => (
              <span key={s.n} className="ev-b-span" data-skip={s.skip ? "" : undefined} style={{ left: tileLeft(s.from), width: (s.to - s.from + 1) * W + (s.to - s.from) * GAP }} title={s.skip ?? undefined}>
                <span className="ev-b-span-label">{s.skip ? `class ${s.n} does not load` : `class ${s.n}: renders alike`}</span>
              </span>
            ))}
          </div>
        )}
        {model.tiles.length === 0 && <div className="ev-b-note ev-b-ruler-empty">No candidate commits: the range holds nothing to search.</div>}
      </div>
    </div>
  );
}
