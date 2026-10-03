// The judged half of a rep's verdict: each check with its weight, its score
// against its floor and the judge's own reasoning, the floors it missed, every
// score version the folder keeps, and, before a rep is scored, the rubric it
// will be held to.

import type { CheckResultJson, RunResponse, ScoreJson, ScoreVersion } from "@codecast/shared/contracts/evalsApi";
import { PASS_MARK } from "./charts/scale";
import { AnchorLink } from "./GateList";
import { Caret } from "./CallPane";
import { ScoreBar, VerdictGlyph, score2, usd } from "./parts";

export const checkAnchor = (id: string) => `check-${id}`;

/** A check's own state, read the way ScoreBar draws it: at the pass mark and over its `must` floor. */
export const checkPasses = (c: Pick<CheckResultJson, "score" | "must">, passMark = PASS_MARK) => c.score >= passMark && (c.must === null || c.must === undefined || c.score >= c.must);

export function JudgeChecks({ score, target, anchorHref, onAnchor }: { score: ScoreJson; target: string | null; anchorHref: (anchor: string) => string; onAnchor: (anchor: string) => void }) {
  if (!score.checks.length) return <div className="ev-rows"><div className="ev-empty-note">No judged checks: this rep's score is its gates alone.</div></div>;
  return (
    <div className="ev-rows" data-ev-checks>
      {score.checks.map((c) => {
        const anchor = checkAnchor(c.id);
        return (
          <div key={c.id} id={anchor} className="ev-row" data-ev-check={c.id} data-ev-target={target === anchor}>
            <div className="ev-row-line">
              <VerdictGlyph state={checkPasses(c, score.passMark) ? "pass" : "fail"} />
              <span className="ev-row-id">{c.id}</span>
              <span className="ev-check-weight" title="This check's share of the total">weight {score2(c.weight)}</span>
              <ScoreBar score={c.score} passMark={score.passMark ?? PASS_MARK} floor={c.must ?? null} width={140} />
              {c.must !== null && c.must !== undefined && <span className="ev-check-weight" title="Below this the rep fails whatever its total">floor {score2(c.must)}</span>}
              <AnchorLink anchor={anchor} href={anchorHref(anchor)} onAnchor={onAnchor} label={`Link to check ${c.id}`} />
            </div>
            {c.ask && <div className="ev-check-ask">{c.ask}</div>}
            {c.reasoning && <div className="ev-judge ev-check-reason">{c.reasoning}</div>}
            {c.evidence && <div className="ev-row-body">{c.evidence}</div>}
          </div>
        );
      })}
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
    <div className="ev-card overflow-hidden" data-ev-score-history>
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
              <td className="ev-tabular">{v.scoredAt ? new Date(v.scoredAt).toLocaleString() : <span className="ev-quiet">not recorded</span>}</td>
              <td className="ev-mono">{v.judgeModel ?? "none"}</td>
              <td>
                <span className="inline-flex items-center gap-2">
                  <VerdictGlyph state={v.pass ? "pass" : "fail"} size={10} />
                  <span className="ev-tabular">{score2(v.score)}</span>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {legacy && <div className="ev-empty-note" style={{ borderTop: "1px solid var(--ev-rule)" }}>First and latest only: this folder predates keeping every rejudge, so the versions between were not kept.</div>}
    </div>
  );
}

/** Before a rep is scored: what it will be held to. */
const RUBRIC_HEAD: Record<"unscored" | "dry" | "crash", string> = {
  unscored: "Not scored yet. It will be held to this.",
  dry: "A dry render is never graded. A live rep of this freeze is held to this.",
  crash: "A crashed rep is never scored. A rep that replies is held to this.",
};

export function RubricCard({ rubric, status = "unscored" }: { rubric: NonNullable<RunResponse["rubric"]>; status?: "unscored" | "dry" | "crash" }) {
  return (
    <div className="ev-card ev-rubric" data-ev-rubric={status}>
      <div className="ev-title">
        <VerdictGlyph state={status} /> {RUBRIC_HEAD[status]}
      </div>
      <div>{rubric.criteria ?? <span className="ev-quiet">This freeze has no criteria: every rep reports a vacuous pass until it gets some.</span>}</div>
      <div className="ev-quiet text-[12px] ev-tabular">Pass mark {score2(rubric.passMark)}, after every gate holds.</div>
    </div>
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
