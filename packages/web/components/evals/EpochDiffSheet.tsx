// What changed at a prompt epoch (docs/architecture/evals-ui.md 4.2 and 3.3):
// per freeze, the rendered prompt files of the last rep before the boundary
// against the first rep after it, which is exactly what the model saw, dirty
// or not; then the commits that landed in the window between the two epochs.

import { GitCommit, X } from "lucide-react";
import type { EpochResponse } from "@codecast/shared/contracts/evalsApi";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "../ui/sheet";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { PromptDiff, shortSha } from "./parts";
import type { PromptFilePair } from "@codecast/shared/contracts/evalsApi";

export interface EpochDiffSheetProps {
  /** The epoch open, or null when the sheet is closed. */
  n: number | null;
  res: EpochResponse | null;
  loading: boolean;
  error: string | null;
  /** Freeze names by id, for the diff headings. */
  freezeNames: Record<string, string>;
  onClose: () => void;
}

const fmtWhen = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function EpochDiffSheet({ n, res, loading, error, freezeNames, onClose }: EpochDiffSheetProps) {
  const e = res && res.epoch.n === n ? res : null;
  const byFreeze = new Map<string, NonNullable<typeof e>["diffs"]>();
  for (const d of e?.diffs ?? []) (byFreeze.get(d.freezeId) ?? byFreeze.set(d.freezeId, []).get(d.freezeId)!).push(d);
  return (
    <Sheet open={n !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" hideClose className="ev-sf-sheet" data-ev-epoch-sheet={n ?? undefined}>
        <header className="ev-sf-sheet-head">
          <div className="min-w-0">
            <SheetTitle className="ev-sf-sheet-title">
              <span className="ev-sf-epoch-chip">e{n}</span>
              {n === 1 ? "The first prompt on record" : `The prompt changed at epoch ${n}`}
            </SheetTitle>
            <SheetDescription className="ev-sf-sheet-sub">
              {e
                ? `Began ${fmtWhen(e.epoch.firstBatchAt)} on ${shortSha(e.epoch.gitHead)}, ${e.epoch.changedFreezes.length} ${e.epoch.changedFreezes.length === 1 ? "freeze" : "freezes"} rendered differently${e.epoch.scope === "analyzer-only" ? " (analyzer prompt only)" : ""}.`
                : loading
                  ? "Reading both sides of the boundary..."
                  : (error ?? "")}
            </SheetDescription>
          </div>
          <span className="flex items-center gap-2 shrink-0">
            <KeyCap size="xs">esc</KeyCap>
            <SheetClose className="ev-sf-iconbtn" aria-label="Close">
              <X className="w-3.5 h-3.5" />
            </SheetClose>
          </span>
        </header>

        {e && (
          <div className="ev-sf-sheet-body">
            {!e.previous ? (
              <p className="ev-sf-note ev-quiet">Nothing earlier is on record for this surface, so there is no prompt to diff against.</p>
            ) : (
              <section className="ev-sf-section">
                <h4 className="ev-title">
                  Rendered prompts, last rep of e{e.previous.n} against first rep of e{e.epoch.n}
                </h4>
                {byFreeze.size === 0 && <p className="ev-sf-note ev-quiet">No freeze ran on both sides of the boundary.</p>}
                {[...byFreeze].map(([freezeId, pairs]) => (
                  <div key={freezeId} className="ev-sf-sheet-freeze" data-ev-epoch-freeze={freezeId}>
                    <div className="ev-sf-sheet-freeze-name">
                      {freezeNames[freezeId] ?? freezeId.slice(0, 8)} <span className="ev-quiet ev-mono">{freezeId.slice(0, 8)}</span>
                    </div>
                    <ChangedPrompts pairs={pairs} />
                  </div>
                ))}
              </section>
            )}
            <section className="ev-sf-section" data-ev-epoch-commits>
              <h4 className="ev-title">
                <GitCommit className="w-3.5 h-3.5 ev-quiet" />
                {e.commits.length ? `${e.commits.length} ${e.commits.length === 1 ? "commit" : "commits"} in the window` : "No commit touched the declared sources in the window"}
              </h4>
              <ul className="ev-sf-commits">
                {e.commits.map((c) => (
                  <li key={c.sha} data-ev-commit={c.sha}>
                    <span className="ev-chip" title={c.sha}>
                      {shortSha(c.sha, 9)}
                    </span>
                    <span className="ev-sf-commit-subject">{c.subject}</span>
                    <span className="ev-quiet ev-tabular">
                      {c.author.split(" ")[0]}, {fmtWhen(c.at)}
                    </span>
                    {!c.onMain && <span className="ev-chip ev-chip--offbranch" title="On no branch; main-line twin">main {shortSha(c.mainSha)}</span>}
                    {c.session && (
                      <a className="ev-chip" href={`/conversation/${c.session}`} title="The session that wrote it (Codecast-Session trailer)">
                        {c.session}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
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
