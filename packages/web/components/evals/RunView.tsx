// One run in full (docs/architecture/evals-ui.md section 4.4), props only:
// everything one rep did and why it scored what it did. RunPage feeds it from
// GET /run/:id and the freeze's GET /freeze/:id (the moment, the production
// reply, and the freeze's other runs and epochs for the prompt diffs); the
// fixture in __fixtures__/run.ts feeds it in the mount test. It reads the app
// only through its host (host.tsx): the key hints, and the tabs the host adds
// after Verdict and Moment (useRunPanels: codecast's calls, agent, guard and
// files).

import { useEffect, useRef, type ReactNode } from "react";
import { ArrowLeftRight, FolderOpen, RotateCcw, Scale } from "lucide-react";
import type { FreezeResponse, RunResponse, RunRow, ScoreJson } from "@codecast/shared/contracts/evalsApi";
import { PASS_MARK, score2, shortSha, usd, verdictOfRow, RUN_TABS, RUN_TAB_WORDS, epochOfBatch, previousEpochRun, seedNeighbours, samePromptSpread, runCommands, compareCandidates, replyReading, rubricOfRun, dryGradeWords, dodgeOffsets, replyOfRun } from "@platform/evals/client";
import { evalsHref } from "./evalsPaths";
import { MomentPane, ProductionCard } from "./FreezeView";
import { GateList } from "./GateList";
import { useEvalsHost, type RunPanel } from "./host";
import { JudgeCall, JudgeChecks, MissedFloors, RubricCard, ScoreHistory } from "./JudgeChecks";
import { Caret, CopyButton, EvalsLink, KeyHint, LockBadge, ProvenanceChips, TextPane, VerdictGlyph } from "./parts";

// ── Header ──────────────────────────────────────────────────────────────────

/** The score as a ruler from 0 to 1 with the pass mark ruled through it. */
function BigRuler({ score, passMark, state }: { score: number | null; passMark: number; state: string }) {
  return (
    <div className={`ev-ruler-big ${state === "pass" ? "ev-pass" : state === "fail" ? "ev-fail" : "ev-quiet"}`} aria-hidden data-ev-ruler>
      <span className="ev-ruler-big-track" />
      {score !== null && <span className="ev-ruler-big-fill" style={{ width: `${Math.max(0.5, Math.min(1, score) * 100)}%` }} />}
      <span className="ev-ruler-big-mark" style={{ left: `${passMark * 100}%` }} title={`pass mark ${passMark}`} />
      <span className="ev-ruler-big-ticks">
        <span>0</span>
        <span style={{ position: "absolute", left: `${passMark * 100}%`, transform: "translateX(-50%)" }}>{passMark}</span>
        <span>1</span>
      </span>
    </div>
  );
}

/** This batch's reps on the same freeze as dots on the score line, so a glance says whether this rep is typical. */
function SeedStrip({ row, all }: { row: RunRow; all: RunRow[] }) {
  const W = 240;
  const H = 26;
  const x = (s: number) => 8 + Math.max(0, Math.min(1, s)) * (W - 16);
  const mark = row.passMark ?? PASS_MARK;
  const xs = all.map((r) => (r.score === null ? x(0) : x(r.score)));
  const dy = dodgeOffsets(xs);
  const selfAt = all.findIndex((r) => r.id === row.id);
  return (
    <div className="ev-seeds" data-ev-seed-strip>
      <span>
        {all.length} rep{all.length === 1 ? "" : "s"} of this freeze in the batch
      </span>
      <div className="ev-seeds-plot ev-bench">
        <svg width={W} height={H} role="group" aria-label="Reps of this freeze in this batch">
          <line x1={x(0)} x2={x(1)} y1={H / 2} y2={H / 2} className="ev-seeds-track" />
          <line x1={x(mark)} x2={x(mark)} y1={2} y2={H - 2} className="ev-strip-mark" />
          {all.map((r, i) => {
            const cx = xs[i]!;
            const cy = H / 2 + dy[i]!;
            const state = verdictOfRow(r);
            const self = r.id === row.id;
            const label = `seed ${r.seed}: ${r.score === null ? state : score2(r.score)}${self ? " (this rep)" : ""}`;
            const dot = (
              <g className={state === "pass" ? "ev-pass" : state === "fail" ? "ev-fail" : "ev-quiet"}>
                {state === "crash" ? (
                  <path d={`M${cx - 3.5},${cy - 3.5} L${cx + 3.5},${cy + 3.5} M${cx + 3.5},${cy - 3.5} L${cx - 3.5},${cy + 3.5}`} stroke="currentColor" strokeWidth={1.6} />
                ) : (
                  <circle cx={cx} cy={cy} r={4} fill={state === "pass" ? "currentColor" : "var(--ev-card)"} stroke="currentColor" strokeWidth={1.5} />
                )}
                <title>{label}</title>
              </g>
            );
            return self ? (
              <g key={r.id} data-ev-seed={r.seed} data-ev-self>
                {dot}
              </g>
            ) : (
              <EvalsLink key={r.id} href={evalsHref.run(r.id)} className="ev-seed-dot" aria-label={label} data-ev-seed={r.seed}>
                {dot}
              </EvalsLink>
            );
          })}
          {/* "This rep" rides its own top layer, so no later rep paints over the ring and the ring hides no neighbour. */}
          {selfAt >= 0 && <circle cx={xs[selfAt]} cy={H / 2 + dy[selfAt]!} r={7} className="ev-seed-self" data-ev-seed-self-ring />}
        </svg>
      </div>
    </div>
  );
}

function ComparePicker({ run, freezeRuns, onClose }: { run: RunResponse; freezeRuns: readonly RunRow[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const groups = compareCandidates(run, freezeRuns);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    ref.current?.querySelector<HTMLElement>("a")?.focus();
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="ev-picker" role="listbox" aria-label="Compare with" data-ev-picker>
      {!groups.length && <div className="ev-empty-note">No other rep of this freeze to compare with.</div>}
      {groups.map((g) => (
        <div key={g.group}>
          <div className="ev-picker-group">{g.group}</div>
          {g.rows.map((c) => (
            <EvalsLink key={c.id} href={evalsHref.compare(run.row.id, c.id)} className="ev-picker-item" role="option" onClick={onClose} data-ev-pick={c.id}>
              {c.row ? <VerdictGlyph state={verdictOfRow(c.row)} size={10} /> : <span style={{ width: 10 }} />}
              <span>{c.label}</span>
              <span className="ev-grow" />
              {c.row && <span className="ev-tabular">{score2(c.row.score)}</span>}
              <span className="ev-mono">{shortSha(c.row?.gitHead ?? null)}</span>
            </EvalsLink>
          ))}
        </div>
      ))}
    </div>
  );
}

/** A page's keys as the host draws them (codecast reads its registry, so a hint never drifts from its binding). */
function Keys({ actions, children }: { actions: Record<string, string>; children: ReactNode }) {
  return (
    <span className="ev-keys">
      {Object.entries(actions).map(([action, keys]) => (
        <KeyHint key={action} action={action} keys={keys} />
      ))}
      {children}
    </span>
  );
}

const noPanels = (): RunPanel[] => [];

// ── The view ────────────────────────────────────────────────────────────────

export interface RunViewProps {
  run: RunResponse;
  /** The freeze's own record: its moment, production reply, other runs and epochs. Null while it loads. */
  freeze: FreezeResponse | null;
  evalsHome: string | null;
  /** The open tab: Verdict, Moment, or a host panel's id. A name the run has no tab for opens Verdict. */
  tab: string;
  onTab: (tab: string) => void;
  /** The gate or check the address names, highlighted where it sits. */
  target: string | null;
  anchorHref: (anchor: string) => string;
  onAnchor: (anchor: string) => void;
  picking: boolean;
  onPicking: (open: boolean) => void;
  overlayProduction: boolean;
  onOverlayProduction: (on: boolean) => void;
  /** The rep is still being written: a pulse says so. */
  landing?: boolean;
}

export function RunView(p: RunViewProps) {
  const { run, freeze } = p;
  const row = run.row;
  const state = verdictOfRow(row);
  const passMark = run.score?.passMark ?? row.passMark ?? PASS_MARK;
  const epochs = freeze?.epochs ?? [];
  const epoch = epochOfBatch(row.batchAt, epochs);
  const prevEpoch = freeze ? previousEpochRun(row, freeze.runs, epochs) : { id: null, why: "The freeze's other runs are still loading" };
  const useRunPanels = useEvalsHost().useRunPanels ?? noPanels;
  const panels = useRunPanels(run, { previousEpoch: prevEpoch });
  const tabs: string[] = [...RUN_TABS, ...panels.map((x) => x.id)];
  const tab = tabs.includes(p.tab) ? p.tab : "verdict";
  const panel = panels.find((x) => x.id === tab) ?? null;
  const seeds = seedNeighbours(row, run.siblings);
  const spread = freeze ? samePromptSpread(row, freeze.runs) : null;
  const cmds = runCommands(row, p.evalsHome);

  return (
    <div className="ev-page ev-run" data-evals-run={row.id} data-ev-run-status={row.status}>
      {run.logTail && (
        <section className="ev-crash" data-ev-crash>
          <header>
            <VerdictGlyph state="crash" size={13} />
            The rep crashed{run.result?.stopReason ? `: ${run.result.stopReason}` : ""}
          </header>
          <pre>{run.logTail}</pre>
        </section>
      )}

      <header className="ev-run-head">
        <div className="ev-run-name">
          <h1 className="ev-page-title">
            {row.surface} <span className="ev-quiet">/</span> {row.freezeName} <span className="ev-quiet">seed {row.seed}</span>
          </h1>
          <span className="ev-mono" title={row.id}>
            {row.id}
          </span>
        </div>
        <div className="ev-run-row">
          <div className="ev-run-score">
            <VerdictGlyph state={state} size={26} />
            <div className="ev-run-score-col">
              <span className={`ev-num ${state === "pass" ? "" : state === "fail" ? "ev-fail" : "ev-quiet"}`} data-ev-score>
                {state === "dry" ? "dry" : row.score === null ? (state === "crash" ? "crash" : "--") : score2(row.score)}
              </span>
              <span className="ev-run-score-word">
                {state === "pass" ? "passed" : state === "fail" ? (row.gatesFailed.length ? `failed at gate ${row.gatesFailed.join(", ")}` : "failed") : state === "crash" ? "crashed, not scored" : state === "dry" ? "dry render, counts toward nothing" : "not scored yet"}
                {p.landing && <span className="ev-pulse">, still landing</span>}
              </span>
            </div>
            <BigRuler score={state === "dry" ? null : row.score} passMark={passMark} state={state} />
          </div>
          <div className="ev-run-meta" data-ev-run-chips>
            <EvalsLink className="ev-chip ev-run-link" href={evalsHref.surface(row.surface, { batch: row.batch })} title="Open the surface at this batch">
              {row.surface}
            </EvalsLink>
            <EvalsLink className="ev-chip ev-run-link" href={evalsHref.freeze(row.freezeId, { batch: row.batch })} title="Open this freeze across time">
              {row.freezeName} {shortSha(row.freezeId)}
            </EvalsLink>
            <LockBadge visibility={row.visibility} />
            <span className="ev-chip" title="The model the rep answered on">
              {row.model ?? "no model"}
            </span>
            <span className="ev-chip" title={row.ruler ? `Judge ruler ${row.ruler}` : "Judge model"}>
              <Scale /> {row.judgeModel ?? "not judged"}
            </span>
            <ProvenanceChips row={row} epoch={epoch?.n ?? null} />
            <span className="ev-chip" title={`model ${usd(row.costUsd)} + judge ${usd(row.judgeCostUsd)}`}>
              {usd(row.costUsd + row.judgeCostUsd)} in {(row.realMs / 1000).toFixed(row.realMs >= 10_000 ? 0 : 1)}s
            </span>
          </div>
        </div>
      </header>

      <div className="ev-run-bar">
        <SeedStrip row={row} all={seeds.all} />
        {spread && (
          <span className="ev-seeds" data-ev-same-prompt={spread.batches} title="This freeze's graded reps that rendered this exact prompt (promptSha), bisect probes left out">
            same prompt, {spread.batches} batches: {score2(spread.min)} to {score2(spread.max)}, passed {spread.passed} of {spread.reps}
          </span>
        )}
        <div className="ev-run-actions">
          <CopyButton text={cmds.path} what="the run folder path" label="path" icon={<FolderOpen />} />
          <CopyButton text={cmds.replay} what="the replay command" label="replay" icon={<RotateCcw />} />
          <CopyButton text={cmds.rescore} what="the rescore command" label="rescore" />
          <span className="ev-run-pick">
            <button type="button" className="ev-btn" aria-pressed={p.picking} aria-haspopup="listbox" onClick={() => p.onPicking(!p.picking)} data-ev-compare-open>
              <ArrowLeftRight /> compare with
            </button>
            {p.picking && <ComparePicker run={run} freezeRuns={freeze?.runs ?? []} onClose={() => p.onPicking(false)} />}
          </span>
        </div>
        <span className="ev-grow" />
        <div className="ev-run-hints">
          <Keys actions={{ "evalsRun.nextSeed": "j", "evalsRun.prevSeed": "k" }}>seed</Keys>
          <Keys actions={{ "evalsRun.prevBatch": "[", "evalsRun.nextBatch": "]" }}>batch</Keys>
          <Keys actions={{ "evalsRun.compare": "c" }}>compare</Keys>
        </div>
      </div>

      <nav className="ev-run-tabs" role="tablist" aria-label="This run">
        {RUN_TABS.map((t) => (
          <button key={t} type="button" role="tab" className="ev-tab" aria-current={t === tab ? "page" : undefined} aria-selected={t === tab} onClick={() => p.onTab(t)} data-ev-tab={t}>
            {RUN_TAB_WORDS[t]}
            {t === "verdict" && state !== "dry" && run.score?.gates.some((g) => !g.pass) && <span className="ev-tab-flag" title="A gate failed" />}
          </button>
        ))}
        {panels.map((x) => (
          <button key={x.id} type="button" role="tab" className="ev-tab" aria-current={x.id === tab ? "page" : undefined} aria-selected={x.id === tab} onClick={() => p.onTab(x.id)} data-ev-tab={x.id}>
            {x.label}
            {x.count !== undefined && <span className="ev-tab-count">{x.count}</span>}
            {x.flag && <span className="ev-tab-flag" title={x.flag} />}
          </button>
        ))}
      </nav>

      <div role="tabpanel" data-ev-panel={tab}>
        {tab === "verdict" && <VerdictTab {...p} />}
        {tab === "moment" && <MomentTab run={run} freeze={freeze} overlay={p.overlayProduction} onOverlay={p.onOverlayProduction} />}
        {panel?.body}
      </div>
    </div>
  );
}

/** Gates, judged checks and missed floors: the parts of a score.json. */
function Grade({ score, p }: { score: ScoreJson; p: RunViewProps }) {
  return (
    <>
      <section className="ev-section">
        <h2 className="ev-title">
          <VerdictGlyph state={score.gates.every((g) => g.pass) ? "pass" : "fail"} /> Gates
          <span className="ev-title-note">
            {score.gates.filter((g) => !g.pass).length} of {score.gates.length} failed
          </span>
        </h2>
        <GateList gates={score.gates} target={p.target} anchorHref={p.anchorHref} onAnchor={p.onAnchor} />
      </section>
      <section className="ev-section">
        <h2 className="ev-title">
          <VerdictGlyph state={score.pass ? "pass" : "fail"} /> Judged checks
          <span className="ev-title-note ev-tabular">
            total {score2(score.score)} against {score2(score.passMark)}
          </span>
        </h2>
        <JudgeChecks score={score} target={p.target} anchorHref={p.anchorHref} onAnchor={p.onAnchor} />
      </section>
      {!!score.missedFloors?.length && (
        <section className="ev-section">
          <h2 className="ev-title">
            <VerdictGlyph state="fail" /> Missed floors
          </h2>
          <MissedFloors floors={score.missedFloors} />
        </section>
      )}
    </>
  );
}

function VerdictTab(p: RunViewProps) {
  const { run } = p;
  const score = run.score;
  const status = run.row.status;
  const dry = status === "dry";
  const reply = replyOfRun(run);
  const rubric = !score || dry ? rubricOfRun(run, p.freeze, run.row.passMark ?? PASS_MARK) : null;
  return (
    <div className="ev-run-verdict" data-ev-verdict-tab>
      {/* The reply first: the judge's reasoning below reads against it, without a trip to the Moment tab. A dry rep has no reply: the model was never called. */}
      {status !== "crash" && !dry && (
        <section className="ev-section" data-ev-verdict-reply>
          <h2 className="ev-title">
            <VerdictGlyph state={verdictOfRow(run.row)} /> What it answered
            <span className="ev-title-note">{replyReading(run)}</span>
          </h2>
          <div className="ev-card ev-verdict-reply">{reply ? <div className="ev-reply-text">{reply}</div> : <div className="ev-empty-note">No reply on record.</div>}</div>
        </section>
      )}
      {score && !dry ? (
        <Grade score={score} p={p} />
      ) : rubric ? (
        <RubricCard rubric={rubric} status={status === "crash" || dry ? status : "unscored"} />
      ) : (
        <div className="ev-card ev-empty-note">{status === "crash" ? "A crashed rep is never scored." : p.freeze ? "No score and no rubric on record for this rep." : "Reading the freeze's criteria..."}</div>
      )}
      {score && dry && (
        <details className="ev-pane" open={!!p.target} data-ev-dry-grade>
          <summary>
            <Caret />
            <span>The tool also graded the rendered prompt</span>
            <span className="ev-pane-size">{dryGradeWords(score)}</span>
          </summary>
          <div className="ev-run-verdict ev-run-fold">
            <div className="ev-empty-note">A dry render never calls the model, so its one send is the prompt it rendered. The grade below scored that prompt as if it were a reply. No verdict, flip or bisect reads it.</div>
            <Grade score={score} p={p} />
            {run.judge && <JudgeCall judge={run.judge} />}
          </div>
        </details>
      )}
      {run.judge && !dry && <JudgeCall judge={run.judge} />}
      {run.scoreVersions.length > 0 && (
        <section className="ev-section">
          <h2 className="ev-title">
            <VerdictGlyph state="unscored" /> Score history
            <span className="ev-title-note">{run.scoreVersions.length} version{run.scoreVersions.length === 1 ? "" : "s"}</span>
          </h2>
          <ScoreHistory versions={run.scoreVersions} />
        </section>
      )}
      {run.extra && (
        <section className="ev-section" data-ev-extra>
          <h2 className="ev-title">
            <VerdictGlyph state="unscored" /> Analyzer grade
          </h2>
          {run.extra.gradeAuto !== undefined && <TextPane name="grade-auto.json" text={JSON.stringify(run.extra.gradeAuto, null, 2)} open />}
          {run.extra.hashes !== undefined && <TextPane name="hashes.json" text={JSON.stringify(run.extra.hashes, null, 2)} />}
        </section>
      )}
    </div>
  );
}

function MomentTab({ run, freeze, overlay, onOverlay }: { run: RunResponse; freeze: FreezeResponse | null; overlay: boolean; onOverlay: (on: boolean) => void }) {
  return (
    <div className="ev-split" data-ev-moment-tab>
      {freeze ? (
        <MomentPane messages={freeze.moment} cutAt={freeze.cutAt} asOf={freeze.freeze.asOf} />
      ) : (
        <div className="ev-card ev-empty-note">Reading the frozen moment...</div>
      )}
      <div className="ev-moment-side">
        <div className="ev-moment-head">
          <span className="ev-title">What this rep sent</span>
          {run.row.status !== "dry" && (
            <span className="ev-title-note">
              {run.sends.length} send{run.sends.length === 1 ? "" : "s"}
            </span>
          )}
          <span className="ev-grow" />
          <button type="button" className="ev-btn" aria-pressed={overlay} onClick={() => onOverlay(!overlay)} disabled={!freeze} data-ev-overlay>
            production reply {overlay ? "on" : "off"}
          </button>
        </div>
        {overlay && freeze && <ProductionCard production={freeze.production} surface={run.row.surface} />}
        <section className="ev-card ev-card--flush" data-ev-sends>
          {run.row.status === "dry" ? (
            <div className="ev-empty-note">A dry render calls no model and sends nothing. What it rendered is on the Calls or Agent tab.</div>
          ) : !run.sends.length ? (
            <div className="ev-empty-note">{run.row.status === "crash" ? "It crashed before sending anything." : "It sent nothing."}</div>
          ) : (
            run.sends.map((s) => (
              <div key={s.seq} className="ev-send" data-ev-send={s.seq}>
                <div className="ev-chips">
                  <span className="ev-chip" title="Rail">{s.rail ?? "no rail"}</span>
                  <span className="ev-chip" title="Audience">{s.audience}</span>
                  {s.to && <span className="ev-chip" title="To">to {s.to}</span>}
                  {s.label && <span className="ev-chip" title="Label">{s.label}</span>}
                  <span className="ev-chip ev-tabular" title="Length">
                    {s.chars.toLocaleString()} chars
                  </span>
                </div>
                <div className="ev-reply-text">{s.text}</div>
              </div>
            ))
          )}
        </section>
      </div>
    </div>
  );
}
