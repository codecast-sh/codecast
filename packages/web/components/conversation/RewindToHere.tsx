"use client";
// "Rewind to here" (lib/rewindFiles): the review of what a rewind of the
// session's files would do, its diff on demand, and the header chip that puts
// a staged rewind back. Each step's state is its sessionCommands row; this
// component holds only which rows it asked for.
import { useState } from "react";
import { History } from "lucide-react";
import { toast } from "sonner";
import { useInboxStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { FilePatchDiff } from "../DiffView";
import { putBackLedger, requestRewind, rewindFailure, rewindLedger, rewindReply, splitRewindDiff, stagedRewindOf, OVERWRITE_OPTIONS } from "../../lib/rewindFiles";
import { agentSupportsFork } from "@codecast/shared/contracts";

/** Whether this viewer can rewind this conversation's files: they run it, on a machine. */
export function useCanRewindFiles(conversationId: string | undefined): boolean {
  return useInboxStore((s) => {
    const c: any = conversationId ? s.conversations[conversationId] ?? s.sessions[conversationId] : null;
    const me = s.currentUser?._id;
    return !!c && !!me && String(c.user_id) === String(me) && !!c.owner_device_id && agentSupportsFork(c.agent_type);
  });
}

const row = (id: string | null) => (s: any) => (id ? s.sessionCommands[id] : undefined);

export function RewindReview({ planId, conversationId, messageTs, subject, onStaged, onClose }: {
  /** The plan step the press asked for (requestRewind "plan"). */
  planId: string;
  conversationId: string;
  messageTs: number;
  subject: string;
  /** The rewind landed: continue in a fork. */
  onStaged: () => void;
  onClose: () => void;
}) {
  const [stageId, setStageId] = useState<string | null>(null);
  const [diffId, setDiffId] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const plan = useInboxStore(row(planId));
  const stage = useInboxStore(row(stageId));
  const now = useCoarseNow(5_000);

  const stageReply = rewindReply(stage);
  const landed = !!stageReply && !stageReply.refused && !!stageReply.staged;
  useWatchEffect(() => {
    if (!landed) return;
    toast.success(`Rewound ${stageReply!.staged!.files.length} files`);
    onStaged();
  }, [landed]);

  const ledger = rewindLedger({
    subject, plan, stage: stage ?? undefined, overwrite, now,
    onDiff: () => setDiffId(requestRewind(conversationId, "diff", { message_ts: messageTs })),
    onPutBack: () => { requestRewind(conversationId, "put_back"); onClose(); },
  });
  const confirm = () => {
    const reply = rewindReply(plan);
    if (!reply?.fingerprint || (stage && !stage.executed_at)) return;
    setStageId(requestRewind(conversationId, "stage", { message_ts: messageTs, fingerprint: reply.fingerprint, overwrite }));
  };
  return (
    <>
      <SwitchReview ledger={ledger} onClose={onClose} onConfirm={confirm} onPick={(o) => setOverwrite(o === OVERWRITE_OPTIONS[1])} />
      {diffId && <RewindDiff requestId={diffId} onClose={() => setDiffId(null)} />}
    </>
  );
}

function RewindDiff({ requestId, onClose }: { requestId: string; onClose: () => void }) {
  const r = useInboxStore(row(requestId));
  const reply = rewindReply(r);
  const failed = rewindFailure(r) ?? reply?.refused;
  const parts = reply?.diff ? splitRewindDiff(reply.diff) : [];
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="w-[56rem] max-w-[calc(100vw-1.5rem)] max-h-[85vh] overflow-y-auto border-sol-border bg-sol-bg p-0 text-sol-text" data-rewind-diff>
        <DialogTitle className="sticky top-0 z-10 border-b border-sol-border/60 bg-sol-bg px-5 py-3 text-[14px] font-semibold">
          Rewind diff <span className="ml-2 text-[12px] font-normal tabular-nums text-sol-text-muted">{reply ? `${parts.length} files${reply.truncated ? ", cut short" : ""}` : failed ? "" : "…"}</span>
        </DialogTitle>
        <DialogDescription className="sr-only">What each file goes back to</DialogDescription>
        <div className="flex flex-col gap-3 px-5 py-4">
          {failed && <p className="text-[13px] text-sol-red">{failed}</p>}
          {!reply && !failed && <p className="text-[13px] text-sol-text-muted">Reading the files…</p>}
          {parts.map((p) => (
            <section key={p.path} className="min-w-0 overflow-hidden rounded-md border border-sol-border/60" data-rewind-diff-file={p.path}>
              <header className="truncate border-b border-sol-border/60 bg-sol-bg-alt/50 px-3 py-1.5 font-mono text-[12px] text-sol-text">{p.path}</header>
              {p.patch.includes("@@") ? <FilePatchDiff patch={p.patch} fileName={p.path} showLineNumbers maxLines={100_000} /> : <p className="px-3 py-2 text-[12px] text-sol-text-muted">{/Binary/.test(p.patch) ? "Binary file" : "Empty file"}</p>}
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The header's mark of a staged rewind in this conversation's checkout (the
 * session or the one it was forked from): how many files, and the two ways to
 * settle it. Put back that finds files edited since asks before discarding them.
 */
export function RewindStagedChip({ conversationId, forkedFrom }: { conversationId: string | undefined; forkedFrom?: string | null }) {
  const sig = useInboxStore((s) => {
    const v = stagedRewindOf(s.sessionCommands, [conversationId, forkedFrom]);
    return v ? `${v.conversationId}|${v.files}|${v.stagedAt}` : "";
  });
  const [putBackId, setPutBackId] = useState<string | null>(null);
  const putBack = useInboxStore(row(putBackId));
  const [reviewing, setReviewing] = useState(false);
  if (!sig) return null;
  const [owner, n] = sig.split("|");
  const refused = rewindReply(putBack)?.refused ? rewindReply(putBack) : null;
  const inFlight = !!putBack && !putBack.executed_at;
  const failed = rewindFailure(putBack);
  return (
    <span className="inline-flex flex-shrink-0 items-center gap-1 px-1 text-[10px] text-sol-orange" data-rewind-staged={n}>
      <History className="h-3 w-3" aria-hidden />
      <span className="hidden sm:inline tabular-nums">Rewound {n}</span>
      <button type="button" disabled={inFlight} onClick={() => setPutBackId(requestRewind(owner, "put_back"))} className="rounded border border-sol-orange/40 px-1 transition-colors hover:bg-sol-orange/10 disabled:opacity-60" title={failed ?? "Restore the files as they were before the rewind"} data-rewind-put-back>
        {inFlight ? "Putting back…" : "Put back"}
      </button>
      <button type="button" disabled={inFlight} onClick={() => requestRewind(owner, "keep")} className="rounded border border-sol-border px-1 text-sol-text-muted transition-colors hover:text-sol-text disabled:opacity-60" title="Keep the rewound files and drop the way back" data-rewind-keep>
        Keep
      </button>
      {refused?.paths?.length && !reviewing ? (
        <button type="button" onClick={() => setReviewing(true)} className="rounded bg-sol-red/15 px-1 text-sol-red" data-rewind-put-back-refused>
          {refused.paths.length} edited
        </button>
      ) : null}
      {reviewing && refused?.paths && (
        <SwitchReview
          ledger={putBackLedger({ paths: refused.paths, total: Number(n) })}
          onClose={() => setReviewing(false)}
          onConfirm={() => { setReviewing(false); setPutBackId(requestRewind(owner, "put_back", { overwrite: true })); }}
        />
      )}
    </span>
  );
}
