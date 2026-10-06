// The free answer (docs/architecture/evals-ui.md 4.5 and section 5, Tier 0):
// what differs between a good batch and a bad one, walked in a fixed order:
// footing, freeze, live reads, source, noise. The first class that differs is
// the answer. A source answer lists its candidate commits with how sure it is,
// the recorded batches that narrowed the window and the prompt epochs inside
// it. The rendered prompt change shows whatever the answer.

import { useEffect, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { ChevronRight } from "lucide-react";
import { ATTRIBUTION_CLASSES, answerFreezeIds, type Attribution, type AttributionClass, type BatchStats, type Candidate, type Endpoint, type Epoch } from "@codecast/shared/contracts/evalsApi";
import { useEvalsResource } from "../../lib/evals/hooks";
import { CommitMarks, CommitPanel, PatchPanel } from "./CommitPanel";
import { ChangedPrompts, EvalsLink, FlipRunLinks, PromptDiff, SeparationMark, VerdictGlyph } from "./parts";
import { candidateKey, endpointLabel, orderCandidates } from "./bisectModel";
import { evalsHref } from "./evalsPaths";
import { plural, score2, shortSha } from "./format";
import { useEvalsHost } from "./host";
import { flipFreezeHref } from "./verdictModel";

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
  // A surface is enough; an end left empty is found from the records.
  const ready = !!draft.surface;
  const changed = draft.surface !== value.surface || draft.good !== value.good || draft.bad !== value.bad;
  return (
    <form className="ev-card ev-b-ends" onSubmit={submit} data-evb-ends>
      <div className="ev-b-field">
        <label htmlFor="ev-b-surface">Surface</label>
        <select id="ev-b-surface" className="ev-b-input" value={draft.surface} onChange={(e) => setDraft({ ...draft, surface: e.target.value })}>
          <option value="">Pick a surface</option>
          {surfaces.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="ev-b-field ev-b-end ev-b-end--good">
        <label htmlFor="ev-b-good">Good: a batch or a sha</label>
        <input id="ev-b-good" className="ev-b-input" list="ev-b-batches" value={draft.good} spellCheck={false} placeholder="its baseline, from the records" onChange={(e) => setDraft({ ...draft, good: e.target.value })} />
        {resolved && !changed && <EndpointChips end={resolved.good} />}
      </div>
      <div className="ev-b-ends-arrow" aria-hidden>
        <svg viewBox="0 0 40 10">
          <path d="M0,5 H36 M31,1 L36,5 L31,9" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </div>
      <div className="ev-b-field ev-b-end ev-b-end--bad">
        <label htmlFor="ev-b-bad">Bad: a batch or a sha</label>
        <input id="ev-b-bad" className="ev-b-input" list="ev-b-batches" value={draft.bad} spellCheck={false} placeholder="newest worse batch" onChange={(e) => setDraft({ ...draft, bad: e.target.value })} />
        {resolved && !changed && <EndpointChips end={resolved.bad} />}
      </div>
      <div className="ev-b-ends-go">
        <button type="submit" className="ev-btn ev-btn--lg" disabled={!ready || !changed}>
          Attribute
        </button>
      </div>
      <datalist id="ev-b-batches">
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
          <circle r={5.6} fill="var(--ev-text)" />
          <circle r={2} fill="var(--ev-bg)" />
        </>
      ) : state === "same" ? (
        <path d="M-4,-1.6 H4 M-4,1.6 H4" stroke="var(--ev-text-dim)" strokeWidth={1.4} strokeLinecap="round" />
      ) : (
        <circle r={4.6} fill="none" stroke="var(--ev-text-dim)" strokeWidth={1.1} strokeDasharray="1.4 1.6" />
      )}
    </svg>
  );
}

/** The five classes in their fixed order; the answer's line is lit, the ones before it read "same", the ones after it were never reached. */
export function AttributionChecklist({ attribution }: { attribution: Attribution }) {
  const answerAt = ATTRIBUTION_CLASSES.indexOf(attribution.answer.kind);
  return (
    <ol className="ev-card ev-b-checklist" data-evb-checklist={attribution.answer.kind}>
      {ATTRIBUTION_CLASSES.map((cls, i) => {
        const line = attribution.checklist.find((c) => c.class === cls);
        const state = i < answerAt ? "same" : i === answerAt ? "answer" : "after";
        return (
          <li key={cls} className="ev-b-check" data-state={state} data-evb-class={cls} aria-current={state === "answer" ? "step" : undefined}>
            <span className="ev-b-check-lamp">
              <Lamp state={state} />
            </span>
            <span className="ev-b-check-name">
              <span className="ev-b-check-n">{i + 1}</span>
              {CLASS_NAMES[cls]}
            </span>
            <span className="ev-b-check-detail">
              {line?.detail ?? (cls === "noise" ? "Reached only when nothing above differs." : "")}
              {state === "after" && line?.differs && <span className="ev-chip ev-b-check-also">also differs</span>}
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
  const { timeAgo } = useEvalsHost().format;
  return (
    <div className="ev-b-cands" data-evb-candidates={candidates.length}>
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
          <div key={key} className={`ev-b-cand-wrap ${isOpen ? "ev-b-cand-wrap--open" : ""}`}>
            {c.kind === "commit" ? (
              <div {...row} className="ev-b-cand" data-evb-candidate={c.commit.sha} title={isOpen ? "Hide the diff" : "Show the diff"}>
                <span className="ev-b-cand-sha" title={c.commit.sha}>
                  <ChevronRight className="ev-b-cand-chev" aria-hidden />
                  {shortSha(c.commit.sha)}
                </span>
                <span className="ev-b-cand-main">
                  <span className="ev-b-cand-subject">{c.commit.subject}</span>
                  <span className="ev-b-cand-meta">
                    {c.commit.author}, {timeAgo(Date.parse(c.commit.at), now)} ago
                  </span>
                </span>
                <span className="ev-b-cand-side">
                  {c.renderClass !== null && <span className="ev-chip" title="Render class: candidates whose dry renders match">class {c.renderClass}</span>}
                  <CommitMarks commit={c.commit} />
                </span>
              </div>
            ) : (
              <div {...row} className="ev-b-cand ev-b-cand--patch" data-evb-candidate="patch" title={isOpen ? "Hide the edits" : "Show the edits"}>
                <span className="ev-b-cand-sha" title={`trees/${c.treePatch}.patch`}>
                  <ChevronRight className="ev-b-cand-chev" aria-hidden />
                  edits
                </span>
                <span className="ev-b-cand-main">
                  <span className="ev-b-cand-subject">Uncommitted edits on top of {shortSha(c.base)}</span>
                  <span className="ev-b-cand-meta">kept as patch {shortSha(c.treePatch, 10)}, replayed with git apply</span>
                </span>
                <span className="ev-b-cand-side">{c.renderClass !== null && <span className="ev-chip">class {c.renderClass}</span>}</span>
              </div>
            )}
            {isOpen && <div className="ev-b-cand-body">{c.kind === "commit" ? <CommitPanel sha={c.commit.sha} surface={surface} /> : <PatchPanel sha={c.treePatch} base={c.base} />}</div>}
          </div>
        );
      })}
    </div>
  );
}

const CONFIDENCES = ["pinned", "narrowed", "unattributable"] as const;

const CONFIDENCE_WORDS: Record<(typeof CONFIDENCES)[number], string> = {
  pinned: "one candidate left: the answer is that commit",
  narrowed: "several candidates left: a bisect can search them",
  unattributable: "no candidate can be trusted: the reason says why",
};

/** A read-only gauge, never a toggle: the reached word beside a three-bar meter, the scale in its title. */
function Confidence({ value }: { value: (typeof CONFIDENCES)[number] }) {
  const level = value === "pinned" ? 3 : value === "narrowed" ? 2 : 0;
  return (
    <span className="ev-b-confidence" role="img" aria-label={`Confidence: ${value}`} title={CONFIDENCES.map((c) => `${c}: ${CONFIDENCE_WORDS[c]}`).join("\n")} data-evb-confidence={value}>
      <svg width={14} height={11} viewBox="0 0 14 11" aria-hidden>
        {[0, 1, 2].map((i) => (
          <rect key={i} x={i * 5} y={7 - i * 3} width={3.5} height={4 + i * 3} rx={0.8} data-on={i < level || undefined} />
        ))}
      </svg>
      {value}
    </span>
  );
}

/** One prompt epoch inside the window: its boundary, and its per-freeze prompt diffs on demand (GET /epoch). */
function EpochRow({ epoch }: { epoch: Epoch }) {
  const [open, setOpen] = useState(false);
  const res = useEvalsResource("GET /epoch", open ? { query: { surface: epoch.surface, n: epoch.n } } : null);
  return (
    <div className="ev-b-epoch" data-evb-epoch={epoch.n}>
      <div className="ev-b-epoch-head">
        <span className="ev-chip">e{epoch.n}</span>
        <span>
          began at batch {endpointLabel(epoch.firstBatch)}, {epoch.changedFreezes.length} {epoch.changedFreezes.length === 1 ? "freeze renders" : "freezes render"} differently
        </span>
        {epoch.gitHead && <span className="ev-chip">{shortSha(epoch.gitHead)}</span>}
        {epoch.scope === "analyzer-only" && <span className="ev-chip">analyzer prompt only</span>}
        <button type="button" className="ev-b-link ev-small" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Hide its prompt diffs" : "Show its prompt diffs"}
        </button>
      </div>
      {open &&
        (res.data ? (
          res.data.diffs.length ? (
            res.data.diffs.map((d) => <PromptDiff key={`${d.freezeId}:${d.file}`} pair={d} />)
          ) : (
            <span className="ev-b-note">No rendered prompt file changed at this boundary.</span>
          )
        ) : (
          <span className="ev-b-note">{res.error ? `Could not read the epoch: ${res.error}` : "Reading the epoch..."}</span>
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
  // A freeze or rubric answer can explain some of the flips and not others: those it leaves are attributed on their own.
  const explained = answerFreezeIds(ans);
  const unexplained = explained ? a.flipped.map((f) => f.freezeId).filter((id) => !explained.includes(id)) : [];
  const partly = explained && unexplained.length > 0 ? ` That explains ${explained.length} of ${a.flipped.length} flipped freezes; the checklist goes on for the rest.` : "";
  const unexplainedLinks = unexplained.length > 0 && (
    <div className="ev-b-unexplained" data-evb-unexplained={unexplained.length}>
      <span className="ev-quiet">Not explained:</span>
      {unexplained.map((id) => (
        <EvalsLink key={id} className="ev-b-link" href={evalsHref.bisectNew({ surface: a.surface, good: a.good.batch ?? a.good.sha, bad: a.bad.batch ?? a.bad.sha, freeze: id })}>
          attribute {freezeName(a, id)} on its own
        </EvalsLink>
      ))}
    </div>
  );
  const freezeChips = (ids: readonly string[]) => (
    <div className="ev-chips">
      {ids.map((id) => (
        <EvalsLink key={id} className="ev-chip" href={evalsHref.freeze(id)}>
          {freezeName(a, id)}
        </EvalsLink>
      ))}
    </div>
  );
  return (
    <section className="ev-card ev-b-answer" data-evb-answer={ans.kind}>
      {ans.kind === "footing" && ans.freezeIds?.length ? (
        <>
          <div className="ev-b-answer-line">
            <span className="ev-b-answer-num">Rubric</span>
            <span className="ev-b-answer-say">
              The per-freeze rubric (a judge or label line in the freeze file) changed on {plural(ans.freezeIds.length, "freeze")} between the two ends; the frozen moment did not. Those reps were graded by a different ruler, so the search stops there.{partly}
            </span>
          </div>
          {freezeChips(ans.freezeIds)}
          {unexplainedLinks}
        </>
      ) : ans.kind === "footing" && (
        <>
          <div className="ev-b-answer-line">
            <span className="ev-b-answer-num">{ans.change === "model" ? "Model" : "Judge"}</span>
            <span className="ev-b-answer-say">
              The {ans.change === "model" ? "model" : "judge's ruler"} changed between the two ends, from <code className="ev-mono">{ans.from ?? "none"}</code> to <code className="ev-mono">{ans.to ?? "none"}</code>. A replay cannot tell that from a prompt change, so the search stops here.
            </span>
          </div>
          <EvalsLink className="ev-b-link ev-small ev-b-start" href={evalsHref.surface(a.surface, { batch: a.bad.batch })}>
            See the footing change on the {a.surface} chart
          </EvalsLink>
        </>
      )}
      {ans.kind === "freeze" && (
        <>
          <div className="ev-b-answer-line">
            <span className="ev-b-answer-num">{ans.freezeIds.length}</span>
            <span className="ev-b-answer-say">
              {ans.freezeIds.length === 1 ? "freeze was" : "freezes were"} captured again between the two ends. The moment the surface answered changed, not the prompt.
              {partly}
            </span>
          </div>
          {freezeChips(ans.freezeIds)}
          {unexplainedLinks}
        </>
      )}
      {ans.kind === "live-reads" && (
        <div className="ev-b-answer-line">
          <span className="ev-b-answer-num ev-live">{ans.reads}</span>
          <span className="ev-b-answer-say">
            live reads across {ans.reps} {ans.reps === 1 ? "rep" : "reps"} on the bad end. Those reps saw the workspace as it was that day, which no replay can see again: not reproducible.
          </span>
        </div>
      )}
      {ans.kind === "noise" && (
        <div className="ev-b-answer-line">
          <span className="ev-b-answer-num">Noise</span>
          <span className="ev-b-answer-say">Nothing differs between the two ends: same footing, same freezes, no live reads, same sources and the same rendered prompt.</span>
          <SeparationMark result={ans.separation} showWord size={14} />
          <span className="ev-quiet ev-b-fine" data-evb-weighed>
            {a.mode === "flip" ? `on the ${plural(a.flipped.length, "flipped freeze")} only` : "on the freezes that fell most only"}
          </span>
        </div>
      )}
      {ans.kind === "source" && ans.confidence === "empty" && (
        <div className="ev-b-empty" data-evb-empty={ans.noDeclaredSourceMoved ? "no-declared-source" : "bracketed"}>
          <div className="ev-b-answer-line">
            <span className="ev-b-answer-num">{ans.noDeclaredSourceMoved ? ans.rangeCommits : 0}</span>
            <span className="ev-b-answer-say">
              {ans.noDeclaredSourceMoved
                ? `${ans.rangeCommits === 1 ? "commit sits" : "commits sit"} between these ends, and none of them touches a source ${a.surface} declares. No candidate is left to search yet.`
                : allCommits?.on
                  ? "candidates left: the recorded batches bracket the fall between two neighbouring commits, and the range holds nothing between them."
                  : "candidates left: the recorded batches bracket the fall to a stretch where no declared source moved."}
            </span>
          </div>
          {ans.rangeCommits > 0 && !allCommits?.on && (
            <div className="ev-b-widen">
              <span>A helper outside the declared sources may be the cause. Searching every commit in the range covers it, at the cost of more probes.</span>
              {allCommits?.onChange && (
                <button type="button" className="ev-btn ev-btn--lg" onClick={() => allCommits.onChange!(true)} data-evb-widen>
                  Search every commit
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {ans.kind === "source" && ans.confidence !== "empty" && (
        <>
          <div className="ev-b-answer-line">
            <span className="ev-b-answer-num">{ans.candidates.length}</span>
            <span className="ev-b-answer-say">
              {ans.confidence === "pinned"
                ? "candidate left: the records name the commit, with no spend."
                : ans.confidence === "narrowed"
                  ? `${ans.candidates.length === 1 ? "candidate" : "candidates"} left in the range. A bisect can replay them to one commit.`
                  : `${ans.candidates.length === 1 ? "candidate" : "candidates"} in the range, and none can be trusted.`}
            </span>
            <Confidence value={ans.confidence} />
          </div>
          {ans.reason && <div className="ev-b-reason">{ans.reason}</div>}
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
            <div className="ev-b-widen" data-evb-widened>
              <span>
                Searching every commit in the range ({plural(ans.rangeCommits, "commit")}), not only the ones touching declared sources.
              </span>
              {allCommits.onChange && (
                <button type="button" className="ev-b-link ev-small" onClick={() => allCommits.onChange!(false)}>
                  Only declared sources
                </button>
              )}
            </div>
          )}
          {ans.narrowedBy.length > 0 && (
            <div className="ev-b-section">
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
            <div className="ev-b-section">
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
  const { ExamplePair } = useEvalsHost().ui;
  return (
    <>
      {a.mode === "score" && a.flipped.length > 0 && (
        <div className="ev-b-note">
          Nothing flipped by majority, so the freezes with the largest median drops stand in: {a.flipped.map((f) => f.name).join(", ")}.
        </div>
      )}
      {a.examples.length > 0 && (
        <section className="ev-b-section" data-evb-examples={a.examples.length}>
          <h2>
            <VerdictGlyph state="fail" size={11} />
            What flipped
          </h2>
          <div className="ev-b-examples">
            {a.examples.map((ex) => {
              const f = a.flipped.find((x) => x.freezeId === ex.freeze);
              return (
                <div key={ex.freeze} data-ev-flip={ex.direction}>
                  <div className="ev-b-example-name">
                    <EvalsLink className="ev-b-link" href={f ? flipFreezeHref(f) : evalsHref.freeze(ex.freeze)}>
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
      <section className="ev-b-section" data-evb-prompt-diffs={a.promptDiffs.length}>
        <h2>What the model saw at each end</h2>
        {a.promptDiffs.length ? (
          [...new Set(a.promptDiffs.map((d) => d.freezeId))].map((f) => {
            const pairs = a.promptDiffs.filter((d) => d.freezeId === f);
            return (
              <div key={f} data-evb-prompt-freeze={f}>
                <div className="ev-b-note">
                  {/* The freeze opened on the two reps diffed here. */}
                  <EvalsLink className="ev-b-link" href={evalsHref.freeze(f, { a: pairs[0].a.runId, b: pairs[0].b.runId })}>
                    {a.flipped.find((x) => x.freezeId === f)?.name ?? `freeze ${shortSha(f)}`}
                  </EvalsLink>
                </div>
                <ChangedPrompts pairs={pairs} />
              </div>
            );
          })
        ) : (
          <div className="ev-b-note">The two ends share no rep on the same freeze, so there is no rendered prompt to compare.</div>
        )}
      </section>
    </>
  );
}

/** The free answer: the checklist, the answer it lit, and the evidence. */
export function AttributionView({ attribution, now = Date.now(), allCommits }: { attribution: Attribution; now?: number; allCommits?: AllCommitsToggle }) {
  return (
    <div className="ev-b-attribution" data-evb-attribution={attribution.answer.kind}>
      <section className="ev-b-section">
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
