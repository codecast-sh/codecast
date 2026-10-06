// What changed at a prompt epoch (docs/architecture/evals-ui.md 4.2 and 3.3):
// per freeze, the rendered prompt files of the last rep before the boundary
// against the first rep after it, which is exactly what the model saw, dirty
// or not; then the commits that landed in the window between the two epochs.
// A product that keeps each prompt by its hash alone (no prompt files) and no
// commits gets the freezes that changed and nothing it cannot fill.

import { GitCommit, X } from "lucide-react";
import { capitalized, plural, shortSha, whenLabel } from "../../client";
import type { EpochResponse } from "../../contract";
import { CommitMarks } from "../bisect/CommitPanel";
import { useCaseNoun, useEvalsCapabilities, useEvalsHost, useEvalsPaths } from "../hooks";
import { ChangedPrompts, EvalsLink } from "../shell/parts";

export interface EpochDiffSheetProps {
  /** The surface, so a commit opens with its diff limited to the declared sources. */
  surface: string;
  /** The epoch open, or null when the sheet is closed. */
  n: number | null;
  res: EpochResponse | null;
  loading: boolean;
  error: string | null;
  /** Freeze names by id, for the diff headings. */
  freezeNames: Record<string, string>;
  onClose: () => void;
}

/** A freeze heading in the sheet: its name, and the short id beside it. */
function FreezeName({ id, names }: { id: string; names: Record<string, string> }) {
  return (
    <div className="ev-sf-sheet-freeze-name">
      {names[id] ?? id.slice(0, 8)} <span className="ev-quiet ev-mono">{id.slice(0, 8)}</span>
    </div>
  );
}

export function EpochDiffSheet({ surface, n, res, loading, error, freezeNames, onClose }: EpochDiffSheetProps) {
  const noun = useCaseNoun();
  const { KeyCap, Sheet } = useEvalsHost().ui;
  const paths = useEvalsPaths();
  const { commits, promptFiles } = useEvalsCapabilities();
  const e = res && res.epoch.n === n ? res : null;
  const byFreeze = new Map<string, NonNullable<typeof e>["diffs"]>();
  for (const d of e?.diffs ?? []) (byFreeze.get(d.freezeId) ?? byFreeze.set(d.freezeId, []).get(d.freezeId)!).push(d);
  return (
    <Sheet.Root open={n !== null} onOpenChange={(open) => !open && onClose()}>
      <Sheet.Content side="right" hideClose className="ev-sf-sheet" data-ev-epoch-sheet={n ?? undefined}>
        <header className="ev-sf-sheet-head">
          <div className="ev-fz-sheet-heading">
            <Sheet.Title className="ev-sf-sheet-title">
              <span className="ev-sf-epoch-chip">e{n}</span>
              {n === 1 ? "The first prompt on record" : `The prompt changed at epoch ${n}`}
            </Sheet.Title>
            <Sheet.Description className="ev-sf-sheet-sub">
              {e
                ? `Began ${whenLabel(e.epoch.firstBatchAt)} on ${shortSha(e.epoch.gitHead)}, ${plural(e.epoch.changedFreezes.length, noun.one, noun.many)} rendered differently${e.epoch.scope === "analyzer-only" ? " (analyzer prompt only)" : ""}.`
                : loading
                  ? "Reading both sides of the boundary..."
                  : (error ?? "")}
            </Sheet.Description>
          </div>
          <span className="ev-fz-sheet-keys">
            <KeyCap size="xs">esc</KeyCap>
            <Sheet.Close className="ev-sf-iconbtn" aria-label="Close">
              <X className="ev-icon" />
            </Sheet.Close>
          </span>
        </header>

        {e && (
          <div className="ev-sf-sheet-body">
            {!e.previous ? (
              <p className="ev-sf-note ev-quiet">Nothing earlier is on record for this surface, so there is no prompt to diff against.</p>
            ) : !promptFiles ? (
              <section className="ev-sf-section" data-ev-epoch-hash-only>
                <h4 className="ev-title">{capitalized(noun.many)} whose prompt changed</h4>
                <p className="ev-sf-note ev-quiet">Each rep's prompt is kept by its hash, not its text, so the change is known here but cannot be shown.</p>
                {e.epoch.changedFreezes.map((freezeId) => (
                  <div key={freezeId} className="ev-sf-sheet-freeze" data-ev-epoch-freeze={freezeId}>
                    <FreezeName id={freezeId} names={freezeNames} />
                  </div>
                ))}
              </section>
            ) : (
              <section className="ev-sf-section">
                <h4 className="ev-title">
                  Rendered prompts, last rep of e{e.previous.n} against first rep of e{e.epoch.n}
                </h4>
                {byFreeze.size === 0 && <p className="ev-sf-note ev-quiet">No {noun.one} ran on both sides of the boundary.</p>}
                {[...byFreeze].map(([freezeId, pairs]) => (
                  <div key={freezeId} className="ev-sf-sheet-freeze" data-ev-epoch-freeze={freezeId}>
                    <FreezeName id={freezeId} names={freezeNames} />
                    <ChangedPrompts pairs={pairs} />
                  </div>
                ))}
              </section>
            )}
            {commits && (
            <section className="ev-sf-section" data-ev-epoch-commits>
              <h4 className="ev-title">
                <GitCommit className="ev-icon ev-quiet" />
                {e.commits.length ? `${e.commits.length} ${e.commits.length === 1 ? "commit" : "commits"} in the window` : "No commit touched the declared sources in the window"}
              </h4>
              <ul className="ev-sf-commits">
                {e.commits.map((c) => (
                  <li key={c.sha} data-ev-commit={c.sha}>
                    <EvalsLink className="ev-chip" href={paths.href.commit(c.sha, { surface })} title={`${c.sha}: open its diff`}>
                      {shortSha(c.sha, 9)}
                    </EvalsLink>
                    <span className="ev-sf-commit-subject">{c.subject}</span>
                    <span className="ev-quiet ev-tabular">
                      {c.author.split(" ")[0]}, {whenLabel(c.at)}
                    </span>
                    <CommitMarks commit={c} />
                  </li>
                ))}
              </ul>
            </section>
            )}
          </div>
        )}
      </Sheet.Content>
    </Sheet.Root>
  );
}
