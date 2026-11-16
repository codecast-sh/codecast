"use client";
// The PR page's Guide tab: the change explained in steps, in the order that
// makes it easiest to follow, each with its reason and its slice of the diff.
// The author's guide when a linked task carries one (written at handoff);
// otherwise one a model writes from the diff when someone asks (prGuides.ts),
// marked stale once newer commits land.

import { useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Route } from "lucide-react";
import type { ChangeGuide, ChangeGuideStep } from "@codecast/shared/contracts/changeGuide";
import { ChangeGuideWalkthrough } from "../tasks/ChangeGuideWalkthrough";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { usd } from "../consequential/lineStartLedger";
import { writeGuideLedger, type PrGuideLedgerPr } from "../../lib/prGuideLedger";
import { useSyncTaskEvidence, useTaskEvidence } from "../../hooks/useSyncTaskEvidence";
import { PR_GUIDE_WRITING_STALE_MS, usePrGuide, useSyncPrGuide, useWritePrGuide, type PrGuideRow } from "../../hooks/useSyncPrGuide";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { prettifyModelId } from "@codecast/shared/contracts/modelOptions";
import { formatRelativeTime } from "../../lib/conversationFormat";
import { formatDiffHash } from "../../lib/prView";

type Pr = PrGuideLedgerPr & { _id: string; head_sha?: string; task_ids?: string[] };

const BTN = "inline-flex items-center gap-1.5 rounded-md border border-sol-border bg-sol-bg-alt px-2.5 py-1 text-[12.5px] text-sol-text hover:border-sol-cyan/60 hover:text-sol-cyan transition-colors";

export function PRGuide({ pr, stepHref, authed }: { pr: Pr; stepHref: (hash: string) => string; authed: boolean }) {
  const taskId = pr.task_ids?.[0];
  useSyncTaskEvidence(taskId);
  const evidence = useTaskEvidence(taskId);
  useSyncPrGuide(pr._id);
  const row = usePrGuide(pr._id);
  const write = useWritePrGuide(pr._id);
  const [reviewing, setReviewing] = useState(false);
  const now = useCoarseNow(30_000);

  const hrefFor = useMemo(() => (step: ChangeGuideStep) => stepHref(formatDiffHash({
    file: step.file,
    ...(step.start !== undefined ? { anchor: { side: "RIGHT" as const, lineNumber: step.start, lineEnd: step.end ?? step.start } } : {}),
  })), [stepHref]);

  const author = evidence?.change_guide?.steps?.length ? evidence.change_guide : null;
  if (author) {
    return (
      <div className="px-6 py-5" data-pr-guide="author">
        <ChangeGuideWalkthrough guide={author} stepHref={hrefFor} />
        <NotInGuide files={pr.files ?? []} steps={author.steps} stepHref={stepHref} />
      </div>
    );
  }

  const writing = row?.status === "writing" && now - row.created_at < PR_GUIDE_WRITING_STALE_MS;
  const failed = row?.status === "failed";
  const written = !!row?.steps?.length;
  const stale = written && !!row!.head_sha && !!pr.head_sha && row!.head_sha !== pr.head_sha;
  const hasFiles = (pr.files?.length ?? 0) > 0;
  const press = authed && hasFiles && !writing ? () => setReviewing(true) : undefined;
  const review = reviewing && (
    <SwitchReview ledger={writeGuideLedger(pr, written)} onClose={() => setReviewing(false)} onConfirm={() => { setReviewing(false); write(); }} />
  );

  if (written) {
    const guide: ChangeGuide = { ...(row!.summary ? { summary: row!.summary } : {}), steps: row!.steps! };
    return (
      <div className="px-6 py-5" data-pr-guide="generated">
        <GeneratedMeta row={row!} stale={stale} writing={writing} failed={failed} onRewrite={press} />
        <ChangeGuideWalkthrough guide={guide} source="an order the model chose from the diff" stepHref={hrefFor} />
        <NotInGuide files={pr.files ?? []} steps={guide.steps} stepHref={stepHref} />
        {review}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 px-6 py-20 text-center" data-pr-guide={writing ? "writing" : failed ? "failed" : "none"}>
      <Route className="h-5 w-5 text-sol-text-dim" />
      {writing ? (
        <span className="inline-flex items-center gap-2 text-[13px] text-sol-text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Writing the guide
        </span>
      ) : (
        <>
          <span className="text-[13px] text-sol-text-muted">{hasFiles ? "No guide for this pull request" : "No file changes synced yet"}</span>
          {failed && row?.error && <span className="max-w-[36rem] text-meta text-sol-red" data-pr-guide-error>{row.error}</span>}
          {press && (
            <button type="button" className={BTN} onClick={press} aria-haspopup="dialog">
              {failed ? "Try again" : "Write guide"}
            </button>
          )}
        </>
      )}
      {review}
    </div>
  );
}

function GeneratedMeta({ row, stale, writing, failed, onRewrite }: { row: PrGuideRow; stale: boolean; writing: boolean; failed: boolean; onRewrite?: () => void }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-sol-text-dim" data-pr-guide-meta>
      <span>Written by {row.model ? prettifyModelId(row.model) : "a model"} from the diff</span>
      {!!row.cost_usd && <span className="tabular-nums">{usd(row.cost_usd)}</span>}
      {!!row.finished_at && <span>{formatRelativeTime(row.finished_at)}</span>}
      {stale && <span className="rounded-full bg-sol-yellow/15 px-2 py-0.5 text-sol-yellow" data-pr-guide-stale>Older than the latest commits</span>}
      {failed && row.error && <span className="max-w-[32rem] truncate text-sol-red" data-pr-guide-error>Rewrite failed: {row.error}</span>}
      {writing ? (
        <span className="inline-flex items-center gap-1.5 text-sol-text-muted"><Loader2 className="h-3 w-3 animate-spin" /> Rewriting</span>
      ) : onRewrite && (
        <button type="button" className={stale ? BTN : "text-sol-text-muted hover:text-sol-cyan transition-colors"} onClick={onRewrite} aria-haspopup="dialog">
          Rewrite
        </button>
      )}
    </div>
  );
}

/** The changed files no step walks through, each opening its diff, so a reader knows what the guide leaves to the Files tab. */
function NotInGuide({ files, steps, stepHref }: { files: readonly { filename: string; additions: number; deletions: number }[]; steps: readonly ChangeGuideStep[]; stepHref: (hash: string) => string }) {
  const walked = new Set(steps.map((s) => s.file));
  const rest = files.filter((f) => !walked.has(f.filename));
  if (!rest.length) return null;
  return (
    <section className="mt-6 border-t border-sol-border/50 pt-4" data-pr-guide-rest={rest.length}>
      <h3 className="mb-2 text-xs font-medium text-sol-text-dim">Not in the guide · {rest.length} {rest.length === 1 ? "file" : "files"}</h3>
      <ul className="flex flex-col gap-0.5">
        {rest.map((f) => (
          <li key={f.filename} className="flex min-w-0 items-baseline gap-3 font-mono text-meta leading-5">
            <Link href={stepHref(formatDiffHash({ file: f.filename }))} className="min-w-0 truncate text-sol-text-muted hover:text-sol-cyan hover:underline" title={`Open ${f.filename} in the diff`}>
              {f.filename}
            </Link>
            <span className="shrink-0 tabular-nums"><span className="text-sol-green">+{f.additions}</span> <span className="text-sol-red">-{f.deletions}</span></span>
          </li>
        ))}
      </ul>
    </section>
  );
}
