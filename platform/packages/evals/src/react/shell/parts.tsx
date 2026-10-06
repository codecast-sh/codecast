// The small pieces every Evals view shares: the verdict glyph, the score bar
// against its pass mark, the provenance chips, the lock badge, a copyable
// command, a reply card, the prompt diff, a folding text pane and a key hint.
// Colour follows fixed meanings (pass cyan, fail magenta, gate red), and state
// is also told by shape (filled against hollow), never by colour alone.

import { forwardRef, useState, type AnchorHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { Check, Copy, GitBranch, GitCompare, Globe, Lock } from 'lucide-react';
import { batchLabel, offBranchWords, pLabel, score2, shortSha, verdictOfRow, type FlipRuns, type VerdictState } from '../../client';
import type { EvalVisibility, EvalsCapabilities, PromptFilePair, RunRowCore, SeparationResult } from '../../contract';
import { useCopy, useEvalsCapabilities, useEvalsHost, useEvalsPaths, usePassMark } from '../hooks';

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

/**
 * A score against the pass mark it names (usePassMark), and against a check's
 * `must` floor when it has one. Where the product records no mark none is
 * drawn, and the bar takes its colour from `passed`, the verdict on record.
 */
export function ScoreBar({ score, passMark: named, passed = true, floor = null, width = 120, showValue = true }: { score: number | null; passMark?: number | null; passed?: boolean; floor?: number | null; width?: number; showValue?: boolean }) {
  const passMark = usePassMark()(named);
  const pass = score !== null && (passMark === null ? passed : score >= passMark) && (floor === null || score >= floor);
  return (
    <span className={`ev-scorebar ${score === null ? "ev-quiet" : pass ? "ev-pass" : "ev-fail"}`} data-ev-scorebar={score === null ? "none" : pass ? "pass" : "fail"}>
      <span className="ev-scorebar-track" style={{ width }}>
        {score !== null && <span className="ev-scorebar-fill" style={{ width: `${Math.max(0, Math.min(1, score)) * 100}%` }} />}
        {passMark !== null && <span className="ev-scorebar-mark" style={{ left: `${passMark * 100}%` }} title={`pass mark ${passMark}`} />}
        {floor !== null && <span className="ev-scorebar-floor" style={{ left: `${floor * 100}%` }} title={`floor ${floor}`} />}
      </span>
      {showValue && <span className="ev-scorebar-value">{score2(score)}</span>}
    </span>
  );
}

// ── PageLink ────────────────────────────────────────────────────────────────

/** A link to a page only some products have: where the capability is off, the same words with nothing to open. */
export function PageLink({ needs, href, className, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; needs: keyof EvalsCapabilities }) {
  return useEvalsCapabilities()[needs] ? (
    <EvalsLink href={href} className={className} {...rest}>
      {children}
    </EvalsLink>
  ) : (
    <span className={className}>{children}</span>
  );
}

// ── LockBadge ───────────────────────────────────────────────────────────────

/** Whether a freeze is committed or kept on this machine. A product that keeps no freezes has neither, so it draws nothing. */
export function LockBadge({ visibility }: { visibility: EvalVisibility }) {
  if (!useEvalsCapabilities().freezes) return null;
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

// ── ModelChip ───────────────────────────────────────────────────────────────

/** The model a rep answered on, for a product whose rows name one. */
export function ModelChip({ model, title }: { model: string | null; title?: string }) {
  return useEvalsCapabilities().models ? (
    <span className="ev-chip" title={title}>
      {model ?? "no model"}
    </span>
  ) : null;
}

// ── ProvenanceChips ─────────────────────────────────────────────────────────

export type ProvenanceRow = Pick<RunRowCore, "surface" | "gitHead" | "mainSha" | "dirty" | "offBranch" | "treePatch" | "batch" | "batchAt" | "cadence" | "liveReads">;

/**
 * Where a rep came from: its head, whether it ran uncommitted edits, its
 * epoch and batch, and whether it read live state. The head opens its commit
 * (scoped to the surface's declared sources) and a kept patch opens itself,
 * so the code a rep ran is one click from anywhere the rep is named.
 */
export function ProvenanceChips({ row, epoch = null, children }: { row: ProvenanceRow; epoch?: number | null; children?: ReactNode }) {
  const evalsHref = useEvalsPaths().href;
  // A product that reads no commits still names the head a rep recorded, with no commit page to open, and draws nothing for a rep that recorded none.
  const { commits } = useEvalsCapabilities();
  return (
    <span className="ev-chips" data-ev-provenance>
      {row.gitHead ? (
        <PageLink needs="commits" className="ev-chip" href={evalsHref.commit(row.gitHead, { surface: row.surface })} title={`${row.gitHead}: open the commit`} data-ev-head={row.gitHead}>
          <GitBranch /> {shortSha(row.gitHead)}
        </PageLink>
      ) : (
        commits && (
          <span className="ev-chip" title="no head recorded">
            <GitBranch /> {shortSha(row.gitHead)}
          </span>
        )
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
  const evalsHref = useEvalsPaths().href;
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
export function ReplyCard({ row, reply, reasoning = null, heading = null, href = null }: { row: RunRowCore; reply: string | null; reasoning?: string | null; heading?: ReactNode; href?: string | null }) {
  return (
    <article className="ev-card ev-reply" data-ev-reply={row.id}>
      <header className="ev-reply-head">
        <VerdictGlyph state={verdictOfRow(row)} size={14} />
        {heading && <span className="ev-title">{heading}</span>}
        <ScoreBar score={row.score} passMark={row.passMark} passed={row.status === "pass"} width={90} />
        <span className="ev-grow" />
        {href && (
          <EvalsLink href={href} className="ev-reply-open">
            open run
          </EvalsLink>
        )}
      </header>
      <div className="ev-chips">
        <ModelChip model={row.model} title="Model" />
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

const noRunFile = (): { text: string | null; loading: boolean } => ({ text: null, loading: false });

/**
 * What the model saw before and after: one rendered prompt file of two reps.
 * Takes the pair when a response already carries its text (/batches, /epoch,
 * /attribution), or two run ids and a file name to fetch.
 */
export function PromptDiff(props: { pair: PromptFilePair } | { a: string; b: string; file: string }) {
  const host = useEvalsHost();
  const fetchArgs = "pair" in props ? null : props;
  const file = "pair" in props ? props.pair.file : props.file;
  // A host that keeps no prompt files reads nothing: the pair, if any, carries its own text.
  const readFile = host.useRunFile ?? noRunFile;
  const a = readFile(fetchArgs?.a ?? null, file);
  const b = readFile(fetchArgs?.b ?? null, file);
  const before = "pair" in props ? props.pair.a.text : a.text;
  const after = "pair" in props ? props.pair.b.text : b.text;
  const loading = !("pair" in props) && (a.loading || b.loading);
  const { DiffView } = host.ui;
  return (
    <section className="ev-card ev-pdiff" data-ev-prompt-diff={file}>
      <header className="ev-title ev-pdiff-head">
        <span className="ev-mono ev-pdiff-file">{file}</span>
        {before === after && before !== null && <span className="ev-pdiff-same">unchanged</span>}
      </header>
      {loading ? (
        <div className="ev-pdiff-note">Reading both prompts...</div>
      ) : fetchArgs && !host.useRunFile ? (
        <div className="ev-pdiff-note">This product keeps no prompt files to compare.</div>
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

// ── Text panes ──────────────────────────────────────────────────────────────

/** The fold arrow on a pane's summary line; it turns when the pane opens. */
export function Caret() {
  return (
    <svg className="ev-caret" viewBox="0 0 12 12" aria-hidden>
      <path d="M4 2.5 L8 6 L4 9.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const sizeWords = (text: string) => {
  const lines = text.split("\n").length;
  return `${lines.toLocaleString()} line${lines === 1 ? "" : "s"}, ${text.length.toLocaleString()} chars`;
};

/** A small copy button; the text it copies shows on hover. */
export function CopyButton({ text, what, label = "copy", icon }: { text: string; what: string; label?: string; icon?: ReactNode }) {
  const [copied, copy] = useCopy(text);
  return (
    <button
      type="button"
      className="ev-btn"
      aria-label={`Copy ${what}`}
      title={text.length <= 200 ? text : undefined}
      onClick={(e) => {
        e.preventDefault();
        void copy();
      }}
    >
      {copied ? <Check /> : icon ?? <Copy />} {label}
    </button>
  );
}

/**
 * A collapsible text file: its name, its size and a copy button on the fold,
 * its text below. `diff` adds the "against the previous epoch" toggle: the
 * button is there whenever the file is a prompt, disabled with its reason when
 * no earlier epoch ran this freeze.
 */
export function TextPane({ name, text, open = false, reply = false, diff, tools }: { name: string; text: string; open?: boolean; reply?: boolean; diff?: { file: string; previous: string | null; current: string; why?: string }; tools?: ReactNode }) {
  const [diffing, setDiffing] = useState(false);
  return (
    <details className="ev-pane" open={open} data-ev-pane={name}>
      <summary>
        <Caret />
        <span className="ev-pane-name">{name}</span>
        <span className="ev-pane-size">{sizeWords(text)}</span>
        <span className="ev-pane-tool">
          {tools}
          {diff && (
            <button
              type="button"
              className="ev-btn"
              aria-pressed={diffing}
              disabled={!diff.previous}
              title={diff.previous ? "What changed in this file since the previous prompt epoch, on the same freeze" : diff.why ?? "No earlier prompt epoch ran this freeze"}
              onClick={(e) => {
                e.preventDefault();
                setDiffing((d) => !d);
              }}
            >
              <GitCompare /> diff against the previous epoch
            </button>
          )}
          <CopyButton text={text} what={name} />
        </span>
      </summary>
      {diffing && diff?.previous ? (
        <div style={{ borderTop: "1px solid var(--ev-rule)" }}>
          <PromptDiff a={diff.previous} b={diff.current} file={diff.file} />
        </div>
      ) : (
        <pre className={`ev-pane-text${reply ? " ev-pane-text--reply" : ""}`}>{text}</pre>
      )}
    </details>
  );
}

// ── KeyHint ─────────────────────────────────────────────────────────────────

/** A page's key for an action, as the host draws and binds it: its registry's caps for the id, else `keys`. */
export function KeyHint({ action, keys }: { action: string; keys: string }) {
  const host = useEvalsHost();
  const { KeyCap } = host.ui;
  return (
    <>
      {host.keyParts(action, keys).map((k) => (
        <KeyCap key={k} size="xs">
          {k}
        </KeyCap>
      ))}
    </>
  );
}
