// The judged half of a rep's verdict: each check with its weight, its score
// against its floor and the judge's own reasoning, the floors it missed, every
// score version the folder keeps, and, before a rep is scored, the rubric it
// will be held to: its criteria and pass mark, and each check by name where
// the product knows them.

import type { ReactNode } from "react";
import { PASS_MARK, score2, usd, whenLabel, checkAnchor, checkPasses, type VerdictState } from "../../client";
import type { RubricCheck, RunResponse, ScoreJson, ScoreVersion } from "../../contract";
import { Caret, ScoreBar, VerdictGlyph } from "../shell/parts";
import { AnchorLink, RubricGates, type AnchorProps } from "./GateList";

/** One check's row: glyph, id and weight, then what is measured (a score bar once scored), its floor, and what it asks. */
function CheckRow({ check, glyph, bar, children, p }: { check: RubricCheck; glyph: ReactNode; bar?: ReactNode; children?: ReactNode; p: AnchorProps }) {
  const anchor = checkAnchor(check.id);
  return (
    <div id={anchor} className="ev-row" data-ev-check={check.id} data-ev-target={p.target === anchor}>
      <div className="ev-row-line">
        {glyph}
        <span className="ev-row-id">{check.id}</span>
        <span className="ev-check-weight" title="This check's share of the total">
          weight {score2(check.weight)}
        </span>
        {bar}
        {check.must !== null && check.must !== undefined && (
          <span className="ev-check-weight" title="Below this the rep fails whatever its total">
            floor {score2(check.must)}
          </span>
        )}
        <AnchorLink anchor={anchor} href={p.anchorHref(anchor)} onAnchor={p.onAnchor} label={`Link to check ${check.id}`} />
      </div>
      {check.ask && <div className="ev-check-ask">{check.ask}</div>}
      {children}
    </div>
  );
}

export function JudgeChecks({ score, ...p }: { score: ScoreJson } & AnchorProps) {
  if (!score.checks.length)
    return (
      <div className="ev-rows">
        <div className="ev-empty-note">No judged checks: this rep's score is its gates alone.</div>
      </div>
    );
  return (
    <div className="ev-rows" data-ev-checks>
      {score.checks.map((c) => (
        <CheckRow
          key={c.id}
          check={c}
          p={p}
          glyph={<VerdictGlyph state={checkPasses(c, score.passMark) ? "pass" : "fail"} />}
          bar={<ScoreBar score={c.score} passMark={score.passMark ?? PASS_MARK} floor={c.must ?? null} width={140} />}
        >
          {c.reasoning && <div className="ev-judge ev-check-reason">{c.reasoning}</div>}
          {c.evidence && <div className="ev-row-body">{c.evidence}</div>}
        </CheckRow>
      ))}
    </div>
  );
}

/** Before a rep is scored: the judged checks its rubric names, each pending. */
export function RubricChecks({ checks, ...p }: { checks: readonly RubricCheck[] } & AnchorProps) {
  return (
    <div className="ev-rows" data-ev-rubric-checks>
      {checks.map((c) => (
        <CheckRow key={c.id} check={c} p={p} glyph={<VerdictGlyph state="unscored" title="not judged yet" />} />
      ))}
    </div>
  );
}

export function MissedFloors({ floors }: { floors: NonNullable<ScoreJson["missedFloors"]> }) {
  if (!floors.length) return null;
  return (
    <div className="ev-rows" data-ev-missed-floors>
      {floors.map((f) => (
        <div key={f.id} className="ev-row">
          <div className="ev-row-line">
            <VerdictGlyph state="fail" />
            <span className="ev-row-id">{f.id}</span>
            <span className="ev-floor ev-tabular">
              scored {score2(f.score)}, under its floor of {score2(f.must)}: the rep fails on this alone
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Every score the folder keeps, newest first. Folders from before every rejudge was kept hold only the first and the latest. */
export function ScoreHistory({ versions }: { versions: readonly ScoreVersion[] }) {
  if (!versions.length) return null;
  const legacy = versions.some((v) => v.legacy);
  const sorted = [...versions].sort((a, b) => (b.scoredAt ?? "").localeCompare(a.scoredAt ?? "") || (a.file === "score.json" ? -1 : 1));
  return (
    <div className="ev-card ev-card--flush" data-ev-score-history>
      <table className="ev-table">
        <thead>
          <tr>
            <th>Version</th>
            <th>Scored</th>
            <th>Judge</th>
            <th>Score</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((v) => (
            <tr key={v.file}>
              <td className="ev-mono">{v.file}</td>
              <td className="ev-tabular">{v.scoredAt ? whenLabel(v.scoredAt) : <span className="ev-quiet">not recorded</span>}</td>
              <td className="ev-mono">{v.judgeModel ?? "none"}</td>
              <td>
                <span className="ev-score-cell">
                  <VerdictGlyph state={v.pass ? "pass" : "fail"} size={10} />
                  <span className="ev-tabular">{score2(v.score)}</span>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {legacy && (
        <div className="ev-empty-note" style={{ borderTop: "1px solid var(--ev-rule)" }}>
          First and latest only: this folder predates keeping every rejudge, so the versions between were not kept.
        </div>
      )}
    </div>
  );
}

/** Before a rep is scored: what it will be held to. */
const RUBRIC_HEAD: Record<"unscored" | "dry" | "crash", string> = {
  unscored: "Not scored yet. It will be held to this.",
  dry: "A dry render counts toward nothing. A live rep of this freeze is held to this.",
  crash: "A crashed rep is never scored. A rep that replies is held to this.",
};

/**
 * The rubric before a score: the criteria and the pass mark, then, where the
 * product names them, the gates and checks it will be held to, drawn as the
 * scored rows will be so the preview and the verdict read alike.
 */
export function RubricCard({ rubric, status = "unscored", ...p }: { rubric: NonNullable<RunResponse["rubric"]>; status?: "unscored" | "dry" | "crash" } & AnchorProps) {
  return (
    <>
      <div className="ev-card ev-rubric" data-ev-rubric={status}>
        <div className="ev-title">
          <VerdictGlyph state={status} /> {RUBRIC_HEAD[status]}
        </div>
        {(rubric.criteria || !(rubric.gates?.length || rubric.checks?.length)) && (
          <div>{rubric.criteria ?? <span className="ev-quiet">This freeze has no criteria: every rep reports a vacuous pass until it gets some.</span>}</div>
        )}
        <div className="ev-rubric-mark ev-tabular">Pass mark {score2(rubric.passMark)}, after every gate holds.</div>
      </div>
      {!!rubric.gates?.length && (
        <section className="ev-section">
          <h2 className="ev-title">
            <VerdictGlyph state="unscored" /> Gates it will be held to
            <span className="ev-title-note">{rubric.gates.length}, any failure fails the rep</span>
          </h2>
          <RubricGates gates={rubric.gates} {...p} />
        </section>
      )}
      {!!rubric.checks?.length && (
        <section className="ev-section">
          <h2 className="ev-title">
            <VerdictGlyph state="unscored" /> Judged checks it will be held to
            <span className="ev-title-note">{rubric.checks.length}</span>
          </h2>
          <RubricChecks checks={rubric.checks} {...p} />
        </section>
      )}
    </>
  );
}

/** The judge's own words on a rep, for a product that keeps them without the call behind them. */
export function JudgeSaid({ words, state }: { words: string; state: VerdictState }) {
  return (
    <section className="ev-section" data-ev-judge-said>
      <h2 className="ev-title">
        <VerdictGlyph state={state} /> What the judge said
      </h2>
      <div className="ev-card ev-verdict-reply">
        <div className="ev-judge">{words}</div>
      </div>
    </section>
  );
}

/** What the judge was asked and what it answered, collapsed. */
export function JudgeCall({ judge }: { judge: NonNullable<RunResponse["judge"]> }) {
  return (
    <details className="ev-pane" data-ev-judge-call>
      <summary>
        <Caret />
        <span>What the judge was asked</span>
        <span className="ev-pane-size">
          {judge.model ?? "no model"}
          {judge.costUsd !== null ? `, ${usd(judge.costUsd)}` : ""}
        </span>
      </summary>
      <pre className="ev-pane-text">{judge.prompt}</pre>
      {judge.reply && <pre className="ev-pane-text">{judge.reply}</pre>}
    </details>
  );
}

