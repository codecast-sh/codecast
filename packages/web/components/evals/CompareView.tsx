// Two runs side by side (docs/architecture/evals-ui.md 4.4, `c` on a run):
// what moved between them (@platform/evals diffRuns: gate flips, then check
// moves of 0.2 or more), both replies, and every rendered prompt file diffed.
// Props only; ComparePage feeds it from GET /compare.

import { ArrowLeftRight } from "lucide-react";
import type { CompareResponse, RunRow } from "@codecast/shared/contracts/evalsApi";
import { evalsHref } from "./evalsPaths";
import { EvalsLink, LockBadge, ProvenanceChips, PromptDiff, ReplyCard, ScoreBar, VerdictGlyph } from "./parts";
import { usd } from "./format";
import { verdictOfRow } from "./verdictModel";
import { diffWords, compareFooting } from "./runModel";

function Side({ tag, row }: { tag: "A" | "B"; row: RunRow }) {
  return (
    <section className="ev-card ev-cmp-side" data-ev-cmp-side={tag}>
      <header>
        <span className="ev-cmp-tag">{tag}</span>
        <VerdictGlyph state={verdictOfRow(row)} size={14} />
        <EvalsLink href={evalsHref.run(row.id)} className="ev-title ev-truncate ev-link" title={row.id}>
          {row.surface} / {row.freezeName} seed {row.seed}
        </EvalsLink>
      </header>
      <ScoreBar score={row.score} passMark={row.passMark ?? undefined} width={160} />
      <div className="ev-chips">
        <LockBadge visibility={row.visibility} />
        <span className="ev-chip">{row.model ?? "no model"}</span>
        <ProvenanceChips row={row} />
        <span className="ev-chip">{usd(row.costUsd + row.judgeCostUsd)}</span>
      </div>
    </section>
  );
}

export function CompareView({ data }: { data: CompareResponse }) {
  const { a, b } = data;
  const footing = compareFooting(a, b);
  return (
    <div className="ev-page ev-run" data-evals-compare>
      <h1 className="ev-page-title">
        <VerdictGlyph state={data.diff.length ? "mixed" : "pass"} size={14} />
        {a.freezeName ?? a.freezeId.slice(0, 8)}
        <span className="ev-cmp-sub ev-quiet">two reps, side by side</span>
      </h1>
      <div className="ev-cmp-head">
        <Side tag="A" row={a} />
        <div className="ev-cmp-mid">
          <EvalsLink href={evalsHref.compare(b.id, a.id)} className="ev-btn" title="Swap the sides" data-ev-swap>
            <ArrowLeftRight /> swap
          </EvalsLink>
        </div>
        <Side tag="B" row={b} />
      </div>
      {footing.length > 0 && (
        <div className="ev-note" data-ev-cmp-footing>
          Not held still: {footing.join("; ")}.
        </div>
      )}

      <section className="ev-section">
        <h2 className="ev-title">
          <VerdictGlyph state={data.diff.length ? "mixed" : "pass"} /> What moved from A to B
          <span className="ev-cmp-sub ev-cmp-sub--sm ev-quiet">gate flips, then checks that moved 0.2 or more</span>
        </h2>
        <div className="ev-rows" data-ev-cmp-diff>
          {!data.diff.length ? (
            <div className="ev-empty-note">Nothing moved: the same gates held and no check moved by 0.2 or more.</div>
          ) : (
            data.diff.map((e) => {
              const w = diffWords(e);
              return (
                <div key={`${e.kind}:${e.id}`} className="ev-diffrow" data-ev-diff={`${e.kind}:${e.id}`} data-ev-diff-tone={w.tone}>
                  <span className="ev-diffrow-kind">{e.kind}</span>
                  <EvalsLink href={evalsHref.run(b.id, `${e.kind}-${e.id}`)} className="ev-row-id ev-link">
                    {e.id}
                  </EvalsLink>
                  <span className="ev-tabular ev-cmp-right">{w.before}</span>
                  <span className={`ev-arrow ${w.tone === "broke" ? "ev-broke" : "ev-fixed"}`}>{w.tone === "broke" ? "↘" : "↗"}</span>
                  <span className={`ev-tabular ${w.tone === "broke" ? "ev-broke" : "ev-fixed"}`}>{w.after}</span>
                </div>
              );
            })
          )}
        </div>
      </section>

      <section className="ev-section">
        <h2 className="ev-title">
          <VerdictGlyph state="unscored" /> Both replies
        </h2>
        <div className="ev-split">
          <ReplyCard row={a} reply={data.replies.a} heading="A" href={evalsHref.run(a.id)} />
          <ReplyCard row={b} reply={data.replies.b} heading="B" href={evalsHref.run(b.id)} />
        </div>
      </section>

      <section className="ev-section">
        <h2 className="ev-title">
          <VerdictGlyph state="unscored" /> Both prompts
          <span className="ev-cmp-sub ev-cmp-sub--sm ev-quiet">{data.prompts.length ? "what the model saw, from A to B" : ""}</span>
        </h2>
        {data.prompts.length ? (
          <div className="ev-cmp-prompts">
            {data.prompts.map((pair) => (
              <PromptDiff key={pair.file} pair={pair} />
            ))}
          </div>
        ) : (
          <div className="ev-card ev-empty-note">{a.freezeId === b.freezeId ? "Neither rep wrote a prompt file." : "The reps answered different freezes, so their prompts are not diffed."}</div>
        )}
      </section>
    </div>
  );
}
