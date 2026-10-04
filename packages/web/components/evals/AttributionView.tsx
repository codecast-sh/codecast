// The free answer (docs/architecture/evals-ui.md 4.5 and section 5, Tier 0):
// what differs between a good batch and a bad one, walked in a fixed order:
// footing, freeze, live reads, source, noise. The first class that differs is
// the answer. A source answer lists its candidate commits with how sure it is,
// the recorded batches that narrowed the window and the prompt epochs inside
// it. The rendered prompt change shows whatever the answer.

import { useEffect, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { ChevronRight } from "lucide-react";
import { ATTRIBUTION_CLASSES, type Attribution, type AttributionClass, type BatchStats, type Candidate, type Endpoint, type Epoch } from "@codecast/shared/contracts/evalsApi";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { useEvalsResource } from "../../lib/evals/hooks";
import { ExamplePair } from "../decisions/ChangeCardView";
import { CommitMarks, CommitPanel, PatchPanel } from "./CommitPanel";
import { ChangedPrompts, EvalsLink, FlipRunLinks, PromptDiff, SeparationMark, VerdictGlyph, flipFreezeHref, plural, score2, shortSha } from "./parts";
import { candidateKey, endpointLabel, orderCandidates } from "./bisectModel";
import { evalsHref } from "./evalsPaths";
import "./bisect.css";

const CLASS_NAMES: Record<AttributionClass, string> = { footing: "Footing", freeze: "Freeze", "live-reads": "Live reads", source: "Source", noise: "Noise" };

// ── Endpoints ───────────────────────────────────────────────────────────────

export interface EndpointsValue {
  surface: string;
  good: string;
  bad: string;
}

function EndpointChips({ end }: { end: Endpoint }) {
  return (
    <span className="ev-chips">
      {end.batch && <span className="ev-chip" title={`Batch ${end.batch}`}>{endpointLabel(end.batch)}</span>}
      <span className="ev-chip" title={end.sha}>{shortSha(end.sha)}</span>
      {end.mainSha && end.mainSha !== end.sha && <span className="ev-chip ev-chip--offbranch" title="On no branch: its main-line twin">main {shortSha(end.mainSha)}</span>}
      {end.dirty && (
        <span className="ev-chip ev-chip--dirty" title={end.treePatch ? `Uncommitted edits, kept as trees/${end.treePatch}.patch` : "Uncommitted edits, no patch kept: not replayable"}>
          dirty{end.treePatch ? `, patch ${shortSha(end.treePatch, 6)}` : ", no patch"}
        </span>
      )}
      <span className="ev-chip" title={`Judge ruler ${end.footing.ruler ?? "none"}`}>{end.footing.model ?? "no model"}</span>
    </span>
  );
}

/**
 * Good and bad, as batches or shas, editable. The batch list is the
 * surface's last 30 days from the wall, so a pick needs no typing.
 */
export function EndpointsBar({ surfaces, batches, value, resolved, onSubmit }: { surfaces: string[]; batches: BatchStats[]; value: EndpointsValue; resolved: { good: Endpoint; bad: Endpoint } | null; onSubmit: (v: EndpointsValue) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value.surface, value.good, value.bad]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({ surface: draft.surface.trim(), good: draft.good.trim(), bad: draft.bad.trim() });
  };
  const ready = draft.surface && draft.good && draft.bad;
  const changed = draft.surface !== value.surface || draft.good !== value.good || draft.bad !== value.bad;
  return (
    <form className="ev-card evb-ends" onSubmit={submit} data-evb-ends>
      <div className="evb-field">
        <label htmlFor="evb-surface">Surface</label>
        <select id="evb-surface" className="evb-input" value={draft.surface} onChange={(e) => setDraft({ ...draft, surface: e.target.value })}>
          <option value="">Pick a surface</option>
          {surfaces.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="evb-field evb-end evb-end--good">
        <label htmlFor="evb-good">Good: a batch or a sha</label>
        <input id="evb-good" className="evb-input" list="evb-batches" value={draft.good} spellCheck={false} placeholder="2026-09-24T08:41:00.000Z" onChange={(e) => setDraft({ ...draft, good: e.target.value })} />
        {resolved && !changed && <EndpointChips end={resolved.good} />}
      </div>
      <div className="evb-ends-arrow" aria-hidden>
        <svg viewBox="0 0 40 10">
          <path d="M0,5 H36 M31,1 L36,5 L31,9" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </div>
      <div className="evb-field evb-end evb-end--bad">
        <label htmlFor="evb-bad">Bad: a batch or a sha</label>
        <input id="evb-bad" className="evb-input" list="evb-batches" value={draft.bad} spellCheck={false} placeholder="newest worse batch" onChange={(e) => setDraft({ ...draft, bad: e.target.value })} />
        {resolved && !changed && <EndpointChips end={resolved.bad} />}
      </div>
      <div className="evb-ends-go">
        <button type="submit" className="evb-btn" disabled={!ready || !changed}>
          Attribute
        </button>
      </div>
      <datalist id="evb-batches">
        {[...batches].reverse().map((b) => (
          <option key={b.batch} value={b.batch}>
            {`${endpointLabel(b.batch)}, median ${score2(b.median)}, ${b.passed} of ${b.reps} passed`}
          </option>
        ))}
      </datalist>
    </form>
  );
}

// ── The checklist ───────────────────────────────────────────────────────────

function Lamp({ state }: { state: "same" | "answer" | "after" }) {
  return (
    <svg width={12} height={12} viewBox="-7 -7 14 14" aria-hidden>
      {state === "answer" ? (
        <>
          <circle r={5.6} fill="var(--sol-text)" />
          <circle r={2} fill="var(--sol-bg)" />
        </>
      ) : state === "same" ? (
        <path d="M-4,-1.6 H4 M-4,1.6 H4" stroke="var(--sol-text-dim)" strokeWidth={1.4} strokeLinecap="round" />
      ) : (
        <circle r={4.6} fill="none" stroke="var(--sol-text-dim)" strokeWidth={1.1} strokeDasharray="1.4 1.6" />
      )}
    </svg>
  );
}

/** The five classes in their fixed order; the answer's line is lit, the ones before it read "same", the ones after it were never reached. */
export function AttributionChecklist({ attribution }: { attribution: Attribution }) {
  const answerAt = ATTRIBUTION_CLASSES.indexOf(attribution.answer.kind);
  return (
    <ol className="ev-card evb-checklist" data-evb-checklist={attribution.answer.kind}>
      {ATTRIBUTION_CLASSES.map((cls, i) => {
        const line = attribution.checklist.find((c) => c.class === cls);
        const state = i < answerAt ? "same" : i === answerAt ? "answer" : "after";
        return (
          <li key={cls} className="evb-check" data-state={state} data-evb-class={cls} aria-current={state === "answer" ? "step" : undefined}>
            <span className="evb-check-lamp">
              <Lamp state={state} />
            </span>
            <span className="evb-check-name">
              <span className="evb-check-n">{i + 1}</span>
              {CLASS_NAMES[cls]}
            </span>
            <span className="evb-check-detail">
              {line?.detail ?? (cls === "noise" ? "Reached only when nothing above differs." : "")}
              {state === "after" && line?.differs && <span className="ev-chip evb-check-also">also differs</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ── Candidates ──────────────────────────────────────────────────────────────

/** Candidate commits in ancestry order, oldest first, the uncommitted patch last. Each row opens its diff in place: what a bisect would be searching. */
export function CandidateList({ candidates, surface, now = Date.now() }: { candidates: readonly Candidate[]; surface: string; now?: number }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="evb-cands" data-evb-candidates={candidates.length}>
      {orderCandidates(candidates).map((c) => {
        const key = candidateKey(c);
        const isOpen = open === key;
        const toggle = () => setOpen(isOpen ? null : key);
        const row = {
          role: "button",
          tabIndex: 0,
          "aria-expanded": isOpen,
          // A pill inside the row is a link of its own.
          onClick: (e: MouseEvent) => !(e.target as Element).closest("a") && toggle(),
          onKeyDown: (e: KeyboardEvent) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle()),
        } as const;
        return (
          <div key={key} className={`evb-cand-wrap ${isOpen ? "is-open" : ""}`}>
            {c.kind === "commit" ? (
              <div {...row} className="evb-cand" data-evb-candidate={c.commit.sha} title={isOpen ? "Hide the diff" : "Show the diff"}>
                <span className="evb-cand-sha" title={c.commit.sha}>
                  <ChevronRight className={`evb-cand-chev ${isOpen ? "rotate-90" : ""}`} aria-hidden />
                  {shortSha(c.commit.sha)}
                </span>
                <span className="min-w-0">
                  <span className="evb-cand-subject block">{c.commit.subject}</span>
                  <span className="evb-cand-meta">
                    {c.commit.author}, {formatTimeAgo(Date.parse(c.commit.at), now)} ago
                  </span>
                </span>
                <span className="evb-cand-side">
                  {c.renderClass !== null && <span className="ev-chip" title="Render class: candidates whose dry renders match">class {c.renderClass}</span>}
                  <CommitMarks commit={c.commit} />
                </span>
              </div>
            ) : (
              <div {...row} className="evb-cand evb-cand--patch" data-evb-candidate="patch" title={isOpen ? "Hide the edits" : "Show the edits"}>
                <span className="evb-cand-sha" title={`trees/${c.treePatch}.patch`}>
                  <ChevronRight className={`evb-cand-chev ${isOpen ? "rotate-90" : ""}`} aria-hidden />
                  edits
                </span>
                <span className="min-w-0">
                  <span className="evb-cand-subject block">Uncommitted edits on top of {shortSha(c.base)}</span>
                  <span className="evb-cand-meta">kept as patch {shortSha(c.treePatch, 10)}, replayed with git apply</span>
                </span>
                <span className="evb-cand-side">{c.renderClass !== null && <span className="ev-chip">class {c.renderClass}</span>}</span>
              </div>
            )}
            {isOpen && <div className="evb-cand-body">{c.kind === "commit" ? <CommitPanel sha={c.commit.sha} surface={surface} /> : <PatchPanel sha={c.treePatch} base={c.base} />}</div>}
          </div>
        );
      })}
    </div>
  );
}

const CONFIDENCES = ["pinned", "narrowed", "unattributable"] as const;

function Confidence({ value }: { value: (typeof CONFIDENCES)[number] }) {
  return (
    <span className="evb-confidence" role="img" aria-label={`Confidence: ${value}`} data-evb-confidence={value}>
      {CONFIDENCES.map((c) => (
        <span key={c} data-on={c === value ? c : undefined}>
          {c}
        </span>
      ))}
    </span>
  );
}

/** One prompt epoch inside the window: its boundary, and its per-freeze prompt diffs on demand (GET /epoch). */
function EpochRow({ epoch }: { epoch: Epoch }) {
  const [open, setOpen] = useState(false);
  const res = useEvalsResource("GET /epoch", open ? { query: { surface: epoch.surface, n: epoch.n } } : null);
  return (
    <div className="flex flex-col gap-2" data-evb-epoch={epoch.n}>
      <div className="flex items-center gap-2 flex-wrap text-[12.5px]">
        <span className="ev-chip">e{epoch.n}</span>
        <span>
          began at batch {endpointLabel(epoch.firstBatch)}, {epoch.changedFreezes.length} {epoch.changedFreezes.length === 1 ? "freeze renders" : "freezes render"} differently
        </span>
        {epoch.gitHead && <span className="ev-chip">{shortSha(epoch.gitHead)}</span>}
        {epoch.scope === "analyzer-only" && <span className="ev-chip">analyzer prompt only</span>}
        <button type="button" className="evb-link text-[12px]" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Hide its prompt diffs" : "Show its prompt diffs"}
        </button>
      </div>
      {open &&
        (res.data ? (
          res.data.diffs.length ? (
            res.data.diffs.map((d) => <PromptDiff key={`${d.freezeId}:${d.file}`} pair={d} />)
          ) : (
            <span className="evb-note">No rendered prompt file changed at this boundary.</span>
          )
        ) : (
          <span className="evb-note">{res.error ? `Could not read the epoch: ${res.error}` : "Reading the epoch..."}</span>
        ))}
    </div>
  );
}

// ── The answer ──────────────────────────────────────────────────────────────

function freezeName(a: Attribution, id: string) {
  return a.flipped.find((f) => f.freezeId === id)?.name ?? id.slice(0, 8);
}

/**
 * Whether the search covers every commit in the range (--all-commits), and the
 * switch that asks again with or without it. Without a switch the card only
 * says which set it searched.
 */
export interface AllCommitsToggle {
  on: boolean;
  onChange?: (on: boolean) => void;
}

/** The answer the checklist lit, in plain words, with what backs it. */
export function AttributionAnswerCard({ attribution: a, now = Date.now(), allCommits }: { attribution: Attribution; now?: number; allCommits?: AllCommitsToggle }) {
  const ans = a.answer;
  return (
    <section className="ev-card evb-answer" data-evb-answer={ans.kind}>
      {ans.kind === "footing" && (
        <>
          <div className="evb-answer-line">
            <span className="evb-answer-num">{ans.change === "model" ? "Model" : "Judge"}</span>
            <span className="evb-answer-say">
              The {ans.change === "model" ? "model" : "judge's ruler"} changed between the two ends, from <code className="ev-mono">{ans.from ?? "none"}</code> to <code className="ev-mono">{ans.to ?? "none"}</code>. A replay cannot tell that from a prompt change, so the search stops here.
            </span>
          </div>
          <EvalsLink className="evb-link text-[12px] self-start" href={evalsHref.surface(a.surface, { batch: a.bad.batch })}>
            See the footing change on the {a.surface} chart
          </EvalsLink>
        </>
      )}
      {ans.kind === "freeze" && (
        <>
          <div className="evb-answer-line">
            <span className="evb-answer-num">{ans.freezeIds.length}</span>
            <span className="evb-answer-say">
              {ans.freezeIds.length === 1 ? "freeze was" : "freezes were"} captured again between the two ends. The moment the surface answered changed, not the prompt.
            </span>
          </div>
          <div className="ev-chips">
            {ans.freezeIds.map((id) => (
              <EvalsLink key={id} className="ev-chip" href={evalsHref.freeze(id)}>
                {freezeName(a, id)}
              </EvalsLink>
            ))}
          </div>
        </>
      )}
      {ans.kind === "live-reads" && (
        <div className="evb-answer-line">
          <span className="evb-answer-num ev-live">{ans.reads}</span>
          <span className="evb-answer-say">
            live reads across {ans.reps} {ans.reps === 1 ? "rep" : "reps"} on the bad end. Those reps saw the workspace as it was that day, which no replay can see again: not reproducible.
          </span>
        </div>
      )}
      {ans.kind === "noise" && (
        <div className="evb-answer-line">
          <span className="evb-answer-num">Noise</span>
          <span className="evb-answer-say">Nothing differs between the two ends: same footing, same freezes, no live reads, same sources and the same rendered prompt.</span>
          <SeparationMark result={ans.separation} showWord size={14} />
        </div>
      )}
      {ans.kind === "source" && ans.confidence === "empty" && (
        <div className="evb-empty" data-evb-empty={ans.noDeclaredSourceMoved ? "no-declared-source" : "bracketed"}>
          <div className="evb-answer-line">
            <span className="evb-answer-num">{ans.noDeclaredSourceMoved ? ans.rangeCommits : 0}</span>
            <span className="evb-answer-say">
              {ans.noDeclaredSourceMoved
                ? `${ans.rangeCommits === 1 ? "commit sits" : "commits sit"} between these ends, and none of them touches a source ${a.surface} declares. No candidate is left to search yet.`
                : allCommits?.on
                  ? "candidates left: the recorded batches bracket the fall between two neighbouring commits, and the range holds nothing between them."
                  : "candidates left: the recorded batches bracket the fall to a stretch where no declared source moved."}
            </span>
          </div>
          {ans.rangeCommits > 0 && !allCommits?.on && (
            <div className="evb-widen">
              <span>A helper outside the declared sources may be the cause. Searching every commit in the range covers it, at the cost of more probes.</span>
              {allCommits?.onChange && (
                <button type="button" className="evb-btn" onClick={() => allCommits.onChange!(true)} data-evb-widen>
                  Search every commit
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {ans.kind === "source" && ans.confidence !== "empty" && (
        <>
          <div className="evb-answer-line">
            <span className="evb-answer-num">{ans.candidates.length}</span>
            <span className="evb-answer-say">
              {ans.confidence === "pinned"
                ? "candidate left: the records name the commit, with no spend."
                : ans.confidence === "narrowed"
                  ? `${ans.candidates.length === 1 ? "candidate" : "candidates"} left in the range. A bisect can replay them to one commit.`
                  : `${ans.candidates.length === 1 ? "candidate" : "candidates"} in the range, and none can be trusted.`}
            </span>
            <Confidence value={ans.confidence} />
          </div>
          {ans.reason && <div className="evb-reason">{ans.reason}</div>}
          {ans.confidence === "pinned" && ans.candidates[0]?.kind === "commit" ? (
            <CommitPanel sha={ans.candidates[0].commit.sha} surface={a.surface} />
          ) : (
            <CandidateList candidates={ans.candidates} surface={a.surface} now={now} />
          )}
        </>
      )}
      {ans.kind === "source" && (
        <>
          {allCommits?.on && (
            <div className="evb-widen" data-evb-widened>
              <span>
                Searching every commit in the range ({plural(ans.rangeCommits, "commit")}), not only the ones touching declared sources.
              </span>
              {allCommits.onChange && (
                <button type="button" className="evb-link text-[12px]" onClick={() => allCommits.onChange!(false)}>
                  Only declared sources
                </button>
              )}
            </div>
          )}
          {ans.narrowedBy.length > 0 && (
            <div className="evb-section">
              <h2>Recorded batches read inside the window</h2>
              <div className="ev-chips">
                {ans.narrowedBy.map((r) => (
                  <EvalsLink key={r.batch} className="ev-chip" href={evalsHref.surface(a.surface, { batch: r.batch })} title={`${plural(r.reps, "rep")} at ${r.sha}`}>
                    <VerdictGlyph state={r.verdict === "good" ? "pass" : r.verdict === "bad" ? "fail" : "unscored"} size={10} />
                    {endpointLabel(r.batch)} at {shortSha(r.sha)}, {r.verdict}
                  </EvalsLink>
                ))}
              </div>
            </div>
          )}
          {ans.epochs.length > 0 && (
            <div className="evb-section">
              <h2>Prompt epochs inside the window</h2>
              {ans.epochs.map((e) => (
                <EpochRow key={e.n} epoch={e} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** The flips behind the regression as before and after pairs, and what the model saw at each end. */
export function AttributionEvidence({ attribution: a }: { attribution: Attribution }) {
  return (
    <>
      {a.mode === "score" && a.flipped.length > 0 && (
        <div className="evb-note">
          Nothing flipped by majority, so the freezes with the largest median drops stand in: {a.flipped.map((f) => f.name).join(", ")}.
        </div>
      )}
      {a.examples.length > 0 && (
        <section className="evb-section" data-evb-examples={a.examples.length}>
          <h2>
            <VerdictGlyph state="fail" size={11} />
            What flipped
          </h2>
          <div className="evb-examples">
            {a.examples.map((ex) => {
              const f = a.flipped.find((x) => x.freezeId === ex.freeze);
              return (
                <div key={ex.freeze} data-ev-flip={ex.direction}>
                  <div className="evb-example-name">
                    <EvalsLink className="evb-link" href={f ? flipFreezeHref(f) : evalsHref.freeze(ex.freeze)}>
                      {ex.name}
                    </EvalsLink>
                    <span className={ex.direction === "broke" ? "ev-fail" : "ev-pass"}>{ex.direction}</span>
                    {f && <FlipRunLinks flip={f} />}
                  </div>
                  <ExamplePair ex={ex} />
                </div>
              );
            })}
          </div>
        </section>
      )}
      <section className="evb-section" data-evb-prompt-diffs={a.promptDiffs.length}>
        <h2>What the model saw at each end</h2>
        {a.promptDiffs.length ? (
          [...new Set(a.promptDiffs.map((d) => d.freezeId))].map((f) => {
            const pairs = a.promptDiffs.filter((d) => d.freezeId === f);
            return (
              <div key={f} data-evb-prompt-freeze={f}>
                <div className="evb-note">
                  {/* The freeze opened on the two reps diffed here. */}
                  <EvalsLink className="evb-link" href={evalsHref.freeze(f, { a: pairs[0].a.runId, b: pairs[0].b.runId })}>
                    {a.flipped.find((x) => x.freezeId === f)?.name ?? `freeze ${shortSha(f)}`}
                  </EvalsLink>
                </div>
                <ChangedPrompts pairs={pairs} />
              </div>
            );
          })
        ) : (
          <div className="evb-note">The two ends share no rep on the same freeze, so there is no rendered prompt to compare.</div>
        )}
      </section>
    </>
  );
}

/** The free answer: the checklist, the answer it lit, and the evidence. */
export function AttributionView({ attribution, now = Date.now(), allCommits }: { attribution: Attribution; now?: number; allCommits?: AllCommitsToggle }) {
  return (
    <div className="flex flex-col gap-4" data-evb-attribution={attribution.answer.kind}>
      <section className="evb-section">
        <h2>
          <VerdictGlyph state={attribution.answer.kind === "noise" ? "pass" : "fail"} size={11} />
          The free answer, from records
        </h2>
        <AttributionChecklist attribution={attribution} />
      </section>
      <AttributionAnswerCard attribution={attribution} now={now} allCommits={allCommits} />
      <AttributionEvidence attribution={attribution} />
    </div>
  );
}
