// The small pieces every Evals view shares (docs/architecture/evals-ui.md
// section 4): the verdict glyph, the score bar against its pass mark, the
// provenance chips, the lock badge, a copyable command, a reply card and the
// prompt diff. Colour follows section 6's fixed meanings, and state is also
// told by shape (filled against hollow), never by colour alone.

import { forwardRef, type AnchorHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { Check, Copy, GitBranch, Globe, Lock } from "lucide-react";
import type { PromptFilePair, RunRow, SeparationResult, EvalVisibility } from "@codecast/shared/contracts/evalsApi";
import { useEvalsResource } from "../../lib/evals/hooks";
import { PASS_MARK } from "./charts/scale";
import { evalsHref } from "./evalsPaths";
import { batchLabel, shortSha, score2, pLabel, offBranchWords } from "./format";
import { useCopy, useEvalsHost } from "./host";
import { type VerdictState, verdictOfRow, type FlipRuns } from "./verdictModel";

// ── EvalsLink ───────────────────────────────────────────────────────────────

/**
 * A link inside the area. A plain click goes through the host's router, which
 * moves the pane the page sits in (a split sibling stays put); a modified
 * click is the browser's, so Cmd-click still opens a tab.
 */
export const EvalsLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(function EvalsLink({ href, onClick, ...rest }, ref) {
  const navigate = useEvalsHost().useNavigate();
  return (
    <a
      ref={ref}
      href={href}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href);
      }}
      {...rest}
    />
  );
});

// ── VerdictGlyph ────────────────────────────────────────────────────────────

const VERDICT_WORDS: Record<VerdictState, string> = { pass: "passed", fail: "failed", crash: "crashed", mixed: "mixed", dry: "dry render", unscored: "not scored yet" };

/** A filled disc for pass, a ring for fail, a cross for crash, a half disc for mixed. */
export function VerdictGlyph({ state, size = 12, title }: { state: VerdictState; size?: number; title?: string }) {
  const tone = state === "pass" ? "ev-pass" : state === "fail" ? "ev-fail" : state === "mixed" ? "ev-fail" : "ev-quiet";
  return (
    <svg className={`ev-glyph ${tone}`} width={size} height={size} viewBox="-7 -7 14 14" role="img" aria-label={title ?? VERDICT_WORDS[state]} data-ev-verdict={state}>
      <title>{title ?? VERDICT_WORDS[state]}</title>
      {state === "pass" && <circle r={5.5} fill="currentColor" />}
      {state === "fail" && <circle r={4.9} fill="none" stroke="currentColor" strokeWidth={1.6} />}
      {state === "crash" && <path d="M-4,-4 L4,4 M4,-4 L-4,4" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" />}
      {state === "mixed" && (
        <>
          <path d="M0,-5.5 A5.5,5.5 0 0 0 0,5.5 Z" className="ev-pass" fill="currentColor" />
          <circle r={4.9} fill="none" stroke="currentColor" strokeWidth={1.6} />
        </>
      )}
      {state === "dry" && <circle r={4.9} fill="none" stroke="currentColor" strokeWidth={1.2} strokeDasharray="1.6 1.6" />}
      {state === "unscored" && <circle r={1.8} fill="currentColor" />}
    </svg>
  );
}

// ── SeparationMark ──────────────────────────────────────────────────────────

const SEPARATION_WORDS = { better: "better", worse: "worse", "not-separated": "not separated", "too-few": "too few reps" } as const;

/** A batch against its baseline: up for better, down for worse, level for not separated, open for too few. */
export function SeparationMark({ result, showWord = false, size = 12 }: { result: SeparationResult | null; showWord?: boolean; size?: number }) {
  const kind = result?.kind ?? "too-few";
  const word = `${SEPARATION_WORDS[kind]}${result && "p" in result ? `, p ${pLabel(result.p)}` : ""}`;
  const tone = kind === "better" ? "ev-pass" : kind === "worse" ? "ev-fail" : "ev-quiet";
  return (
    <span className={`ev-sep ${tone}`} data-ev-separation={kind}>
      <svg width={size} height={size} viewBox="-7 -7 14 14" role="img" aria-label={word}>
        <title>{word}</title>
        {kind === "better" && <path d="M0,-5.5 L5.5,4 L-5.5,4 Z" fill="currentColor" />}
        {kind === "worse" && <path d="M0,5.5 L5.5,-4 L-5.5,-4 Z" fill="currentColor" />}
        {kind === "not-separated" && <path d="M-5,-2 H5 M-5,2 H5" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />}
        {kind === "too-few" && <circle r={4.6} fill="none" stroke="currentColor" strokeWidth={1.2} strokeDasharray="1.4 1.6" />}
      </svg>
      {showWord && <span className="ev-sep-word">{word}</span>}
    </span>
  );
}

// ── ScoreBar ────────────────────────────────────────────────────────────────

/** A score against its pass mark, and against a check's `must` floor when it has one. */
export function ScoreBar({ score, passMark = PASS_MARK, floor = null, width = 120, showValue = true }: { score: number | null; passMark?: number; floor?: number | null; width?: number; showValue?: boolean }) {
  const pass = score !== null && score >= passMark && (floor === null || score >= floor);
  return (
    <span className={`ev-scorebar ${score === null ? "ev-quiet" : pass ? "ev-pass" : "ev-fail"}`} data-ev-scorebar={score === null ? "none" : pass ? "pass" : "fail"}>
      <span className="ev-scorebar-track" style={{ width }}>
        {score !== null && <span className="ev-scorebar-fill" style={{ width: `${Math.max(0, Math.min(1, score)) * 100}%` }} />}
        <span className="ev-scorebar-mark" style={{ left: `${passMark * 100}%` }} title={`pass mark ${passMark}`} />
        {floor !== null && <span className="ev-scorebar-floor" style={{ left: `${floor * 100}%` }} title={`floor ${floor}`} />}
      </span>
      {showValue && <span className="ev-scorebar-value">{score2(score)}</span>}
    </span>
  );
}

// ── LockBadge ───────────────────────────────────────────────────────────────

export function LockBadge({ visibility }: { visibility: EvalVisibility }) {
  return visibility === "private" ? (
    <span className="ev-chip ev-chip--private" title="Private: kept in EVALS_HOME, never in git or a published page" data-ev-lock="private">
      <Lock /> private
    </span>
  ) : (
    <span className="ev-chip" title="Public: committed under packages/evals" data-ev-lock="public">
      <Globe /> public
    </span>
  );
}

// ── ProvenanceChips ─────────────────────────────────────────────────────────

export type ProvenanceRow = Pick<RunRow, "surface" | "gitHead" | "mainSha" | "dirty" | "offBranch" | "treePatch" | "batch" | "batchAt" | "cadence" | "liveReads">;

/**
 * Where a rep came from: its head, whether it ran uncommitted edits, its
 * epoch and batch, and whether it read live state. The head opens its commit
 * (scoped to the surface's declared sources) and a kept patch opens itself,
 * so the code a rep ran is one click from anywhere the rep is named.
 */
export function ProvenanceChips({ row, epoch = null, children }: { row: ProvenanceRow; epoch?: number | null; children?: ReactNode }) {
  return (
    <span className="ev-chips" data-ev-provenance>
      {row.gitHead ? (
        <EvalsLink className="ev-chip" href={evalsHref.commit(row.gitHead, { surface: row.surface })} title={`${row.gitHead}: open the commit`} data-ev-head={row.gitHead}>
          <GitBranch /> {shortSha(row.gitHead)}
        </EvalsLink>
      ) : (
        <span className="ev-chip" title="no head recorded">
          <GitBranch /> {shortSha(row.gitHead)}
        </span>
      )}
      {row.dirty &&
        (row.treePatch ? (
          <EvalsLink className="ev-chip ev-chip--dirty" href={evalsHref.patch(row.treePatch)} title={`Uncommitted edits, kept as trees/${row.treePatch}.patch: open them`} data-ev-patch={row.treePatch}>
            dirty, patch {shortSha(row.treePatch, 6)}
          </EvalsLink>
        ) : (
          <span className="ev-chip ev-chip--dirty" title="Uncommitted edits, no patch kept: not replayable">
            dirty
          </span>
        ))}
      {row.offBranch &&
        (row.mainSha || !row.gitHead ? (
          <span className="ev-chip ev-chip--offbranch" title={offBranchWords(row).title} data-ev-offbranch="twin">
            {offBranchWords(row).label}
          </span>
        ) : (
          <EvalsLink className="ev-chip ev-chip--offbranch" href={evalsHref.commit(row.gitHead, { surface: row.surface })} title={`${offBranchWords(row).title} Open the commit for the reason heads.json records.`} data-ev-offbranch="none">
            {offBranchWords(row).label}
          </EvalsLink>
        ))}
      {epoch !== null && <span className="ev-chip" title={`Prompt epoch ${epoch}`}>e{epoch}</span>}
      {row.batch && (
        <span className="ev-chip" title={`Batch ${row.batch}`}>
          {batchLabel(row.batch, row.batchAt)}
          {row.cadence ? `, ${row.cadence}` : ", by hand"}
        </span>
      )}
      {row.liveReads > 0 && (
        <span className="ev-chip ev-chip--live" title="It read the live workspace, so a replay will not see the same thing">
          live reads {row.liveReads}, not reproducible
        </span>
      )}
      {children}
    </span>
  );
}

/** One rep from each side of a flip, so a failing run is one click from the tile that names it. */
export function FlipRunLinks({ flip, className = "" }: { flip: FlipRuns; className?: string }) {
  const [before, after] = [flip.before[0], flip.after[0]];
  if (!before && !after) return null;
  return (
    <span className={`ev-flip-runs ${className}`} data-ev-flip-runs>
      {before && (
        <EvalsLink href={evalsHref.run(before)} title={before}>
          before run
        </EvalsLink>
      )}
      {after && (
        <EvalsLink href={evalsHref.run(after)} title={after}>
          after run
        </EvalsLink>
      )}
    </span>
  );
}

// ── StallChip ───────────────────────────────────────────────────────────────

/** The flag every live job wears after five quiet minutes (section 3.6): a bisect, a shrink or a sweep. */
export function StallChip({ since, ...rest }: { since: string } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className="ev-stall-chip" title={`No new step since ${new Date(since).toLocaleTimeString()}: check its tmux session or log`} {...rest}>
      stalled?
    </span>
  );
}

// ── LogTail ─────────────────────────────────────────────────────────────────

/**
 * A job's last lines, the newest in view: a bisect's log, or what a shrink or
 * a sweep printed before it ended. Every launched job writes its log, so the
 * reason it stopped is here after its tmux window has closed.
 */
export function LogTail({ lines, label = "Log tail", ...rest }: { lines: readonly string[]; label?: string } & HTMLAttributes<HTMLPreElement>) {
  if (!lines.length) return null;
  return (
    <div className="ev-logtail">
      <span className="ev-logtail-label">{label}</span>
      {/* A column-reverse scroller opens at its end and stays there as lines land, so the newest line is the one in view. */}
      <pre className="ev-log" {...rest}>
        <span>{lines.join("\n")}</span>
      </pre>
    </div>
  );
}

// ── CopyCommand ─────────────────────────────────────────────────────────────

export function CopyCommand({ command, label = "Copy" }: { command: string; label?: string }) {
  const [copied, copy] = useCopy(command);
  return (
    <span className="ev-copy" data-ev-copy>
      <code>{command}</code>
      <button type="button" onClick={() => void copy()} aria-label={`${label}: ${command}`}>
        {copied ? <Check /> : <Copy />}
        {label}
      </button>
    </span>
  );
}

// ── ReplyCard ───────────────────────────────────────────────────────────────

/** One rep's answer: verdict, score, model, batch, head, failed gates and the judge's reasoning. */
export function ReplyCard({ row, reply, reasoning = null, heading = null, href = null }: { row: RunRow; reply: string | null; reasoning?: string | null; heading?: ReactNode; href?: string | null }) {
  return (
    <article className="ev-card ev-reply" data-ev-reply={row.id}>
      <header className="ev-reply-head">
        <VerdictGlyph state={verdictOfRow(row)} size={14} />
        {heading && <span className="ev-title">{heading}</span>}
        <ScoreBar score={row.score} passMark={row.passMark ?? PASS_MARK} width={90} />
        <span className="ev-grow" />
        {href && (
          <EvalsLink href={href} className="ev-reply-open">
            open run
          </EvalsLink>
        )}
      </header>
      <div className="ev-chips">
        <span className="ev-chip" title="Model">{row.model ?? "no model"}</span>
        <ProvenanceChips row={row} />
      </div>
      {row.gatesFailed.length > 0 && (
        <div className="ev-reply-gates">
          {row.gatesFailed.map((g) => (
            <span key={g} className="ev-chip ev-gate">
              gate {g} failed
            </span>
          ))}
        </div>
      )}
      <div className="ev-reply-text">{reply ?? <span className="ev-quiet">No reply recorded.</span>}</div>
      {reasoning && <div className="ev-judge">{reasoning}</div>}
    </article>
  );
}

// ── PromptDiff ──────────────────────────────────────────────────────────────

/**
 * What the model saw before and after: one rendered prompt file of two reps.
 * Takes the pair when a response already carries its text (/batches, /epoch,
 * /attribution), or two run ids and a file name to fetch.
 */
export function PromptDiff(props: { pair: PromptFilePair } | { a: string; b: string; file: string }) {
  const fetchArgs = "pair" in props ? null : props;
  const a = useEvalsResource("GET /run/:id/file", fetchArgs ? { params: { id: fetchArgs.a }, query: { path: fetchArgs.file } } : null);
  const b = useEvalsResource("GET /run/:id/file", fetchArgs ? { params: { id: fetchArgs.b }, query: { path: fetchArgs.file } } : null);
  const file = "pair" in props ? props.pair.file : props.file;
  const before = "pair" in props ? props.pair.a.text : a.data?.text ?? null;
  const after = "pair" in props ? props.pair.b.text : b.data?.text ?? null;
  const loading = !("pair" in props) && (a.loading || b.loading);
  const { DiffView } = useEvalsHost().ui;
  return (
    <section className="ev-card ev-pdiff" data-ev-prompt-diff={file}>
      <header className="ev-title ev-pdiff-head">
        <span className="ev-mono ev-pdiff-file">{file}</span>
        {before === after && before !== null && <span className="ev-pdiff-same">unchanged</span>}
      </header>
      {loading ? (
        <div className="ev-pdiff-note">Reading both prompts...</div>
      ) : before === null && after === null ? (
        <div className="ev-pdiff-note">Neither rep wrote this file.</div>
      ) : (
        <DiffView oldStr={before ?? ""} newStr={after ?? ""} showLineNumbers contextLines={3} />
      )}
    </section>
  );
}

/** The files that changed, diffed; the ones that did not, named on one quiet line so they do not bury the change. */
export function ChangedPrompts({ pairs }: { pairs: readonly PromptFilePair[] }) {
  const same = pairs.filter((p) => p.a.text === p.b.text && p.a.text !== null);
  const changed = pairs.filter((p) => !same.includes(p));
  return (
    <>
      {changed.map((p) => (
        <PromptDiff key={p.file} pair={p} />
      ))}
      {same.length > 0 && (
        <p className="ev-sf-unchanged" data-ev-unchanged={same.length}>
          Unchanged: {same.map((p) => p.file).join(", ")}
        </p>
      )}
    </>
  );
}
