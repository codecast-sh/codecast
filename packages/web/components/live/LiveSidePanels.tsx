// The shell's right-hand panels for a live artifact: comment threads and the
// version history. Both read the store through the live hooks.
import { useMemo, useRef, useState } from "react";
import { Bot, Check, History, RotateCcw, Trash2 } from "lucide-react";
import type { ArtifactElement } from "@codecast/shared/artifacts";
import { useLiveComments, useLiveVersions, type LiveHandle } from "./useLiveArtifact";
import { pickAskTarget, sendAsk, type AskDoc } from "./askAgent";
import { relativeTime } from "../../lib/entityDisplay";
import { useInboxStore } from "../../store/inboxStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { CommentComposer } from "../comments/CommentComposer";
import { CommentMarkdown } from "../comments/CommentMarkdown";
import { groupThreads } from "./liveThreads";
const formatRelative = (ts: number) => relativeTime(ts) ?? "";

export function CommentsPanel({
  doc,
  live,
  selection,
  focusKey,
  selectedElements,
  onFocus,
  readOnly = false,
}: {
  /** A version is open, or the viewer cannot edit: read the threads, write nothing. */
  readOnly?: boolean;
  doc: AskDoc & { team_id?: string };
  live: LiveHandle;
  selection: string[];
  focusKey: string | null;
  selectedElements: ArtifactElement[];
  onFocus: (commentKey: string, anchor?: string) => void;
}) {
  const all = useLiveComments(live.docId);
  const me = useInboxStore((s: any) => s.currentUser?._id as string | undefined);
  const [toAgent, setToAgent] = useState(false);
  const [tab, setTab] = useState<"open" | "resolved">("open");
  const threads = useMemo(() => groupThreads(all), [all]);
  const open = threads.filter((t) => !t.root.resolved);
  const resolved = threads.filter((t) => t.root.resolved);
  const shown = tab === "open" ? open : resolved;
  const anchor = selection[0];
  // A thread opened from a link (?c=) shows wherever it is filed.
  const focusedResolved = focusKey ? threads.find((x) => x.root.key === focusKey)?.root.resolved : undefined;
  const focusKnown = focusedResolved !== undefined || (!!focusKey && threads.some((x) => x.root.key === focusKey));
  useWatchEffect(() => {
    if (focusKnown) setTab(focusedResolved ? "resolved" : "open");
    // Only a newly focused thread (or one that just arrived) moves the tab; resolving the focused one keeps it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, focusKnown]);

  const post = (body: string) => {
    const key = live.comment({ text: body, ...(anchor ? { anchor } : {}) });
    if (toAgent) {
      pickAskTarget("Send this comment to…", (target) => {
        void sendAsk(doc, { prompt: body, selected: selectedElements, comment_key: key }, target);
      });
      setToAgent(false);
    }
  };

  return (
    <div className="flex flex-col h-full" data-live-comments>
      <div className="flex items-center gap-1 px-2 h-9 border-b border-sol-border/40 shrink-0" role="tablist">
        {(["open", "resolved"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            data-live-comments-tab={k}
            onClick={() => setTab(k)}
            className={`h-6 px-2 rounded text-xs ${tab === k ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"}`}
          >
            {k === "open" ? "Open" : "Resolved"} <span className="text-sol-text-dim tabular-nums">{k === "open" ? open.length : resolved.length}</span>
          </button>
        ))}
      </div>
      {!readOnly && (
        <div className="p-2 border-b border-sol-border/30 shrink-0" data-live-comment-new>
          {anchor && <div className="mb-1 text-meta font-mono text-sol-text-dim truncate">on {anchor}</div>}
          <CommentComposer
            conversationId={`live:${doc._id}`}
            scopeKey={`live:${doc._id}:new`}
            enabled={false}
            authed
            mentionTeamId={doc.team_id}
            chatMentionMode
            placeholder="Comment, @ to mention"
            className="ch-composer"
            onSubmit={post}
          />
          <label className="mt-1.5 inline-flex items-center gap-1.5 text-meta text-sol-text-muted cursor-pointer select-none">
            <input type="checkbox" data-live-comment-agent checked={toAgent} onChange={(e) => setToAgent(e.target.checked)} className="accent-[var(--sol-violet)]" />
            Send to agent
          </label>
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        {shown.length === 0 && <div className="px-3 py-6 text-center text-xs text-sol-text-dim">{tab === "open" ? "No open comments" : "Nothing resolved"}</div>}
        {shown.map(({ root, replies }) => (
          <Thread key={root.key} doc={doc} live={live} me={me} root={root} replies={replies} focused={focusKey === root.key} readOnly={readOnly} onFocus={onFocus} />
        ))}
      </div>
    </div>
  );
}

function Thread({ doc, live, me, root, replies, focused, readOnly, onFocus }: {
  doc: AskDoc & { team_id?: string };
  live: LiveHandle;
  me?: string;
  root: ArtifactElement;
  replies: ArtifactElement[];
  focused: boolean;
  readOnly: boolean;
  onFocus: (k: string, anchor?: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useWatchEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);
  const setRoot = (set: Record<string, any>) => live.apply([{ k: root.key, set }], { layer: "comments", undoable: false });
  const remove = (c: ArtifactElement) => {
    // Deleting a thread's first comment takes its replies with it.
    const keys = c.key === root.key ? [root.key, ...replies.map((r) => r.key)] : [c.key];
    live.apply(keys.map((k) => ({ k, del: true as const })), { layer: "comments", undoable: false });
  };
  const mine = (c: ArtifactElement) => !!me && c.author === `u:${me}`;
  return (
    <div
      ref={ref}
      data-live-thread={root.key}
      onClick={() => onFocus(root.key, root.anchor ? String(root.anchor) : undefined)}
      className={`group px-3 py-2.5 border-b border-sol-border/20 cursor-pointer ${focused ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-alt/60"}`}
    >
      <CommentLine c={root} canDelete={!readOnly && mine(root)} onDelete={() => remove(root)} />
      {root.sent_to ? <AskState root={root} /> : null}
      {replies.map((r) => (
        <div key={r.key} className="mt-2 pl-3 border-l border-sol-border/40">
          <CommentLine c={r} canDelete={!readOnly && mine(r)} onDelete={() => remove(r)} />
        </div>
      ))}
      {!readOnly && (
        <div className="mt-1.5 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            data-live-resolve={root.key}
            onClick={() => setRoot({ resolved: root.resolved ? null : true })}
            className="inline-flex items-center gap-1 h-6 px-1.5 rounded text-meta text-sol-text-dim hover:text-sol-green hover:bg-sol-green/10"
          >
            {root.resolved ? <RotateCcw className="w-3 h-3" /> : <Check className="w-3 h-3" />}
            {root.resolved ? "Reopen" : "Resolve"}
          </button>
        </div>
      )}
      {focused && !readOnly && !root.resolved && (
        <div className="mt-1.5" onClick={(e) => e.stopPropagation()} data-live-reply={root.key}>
          <CommentComposer
            conversationId={`live:${doc._id}`}
            scopeKey={`live:${doc._id}:${root.key}`}
            enabled={false}
            authed
            mentionTeamId={doc.team_id}
            chatMentionMode
            placeholder="Reply"
            autoFocus
            className="ch-composer"
            onSubmit={(text) => { live.comment({ text, parent: root.key }); }}
          />
        </div>
      )}
    </div>
  );
}

/** Where an ask stands: with the agent, or answered in this thread. */
function AskState({ root }: { root: ArtifactElement }) {
  const answered = !!root.answered_at;
  return (
    <div className={`mt-1 inline-flex items-center gap-1 h-5 px-1.5 rounded text-meta ${answered ? "bg-sol-green/10 text-sol-green" : "bg-sol-violet/10 text-sol-violet"}`} data-live-ask-state={answered ? "answered" : "working"}>
      <Bot className="w-3 h-3" />
      {answered ? `Answered · ${String(root.answered_by_name ?? "agent")}` : "With agent"}
    </div>
  );
}

function CommentLine({ c, canDelete, onDelete }: { c: ArtifactElement; canDelete: boolean; onDelete: () => void }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-meta">
        <span className={`font-medium ${String(c.author ?? "").startsWith("s:") ? "text-sol-violet" : "text-sol-text"}`}>{String(c.author_name ?? "Someone")}</span>
        {c.anchor ? <span className="font-mono text-sol-text-dim truncate">{String(c.anchor)}</span> : null}
        <span className="flex-1" />
        <span className="text-sol-text-dim">{formatRelative(Number(c.created_at ?? c.at ?? 0))}</span>
        {canDelete && (
          <button
            type="button"
            title="Delete"
            aria-label="Delete comment"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-sol-text-dim hover:text-sol-red"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>
      <div className="mt-0.5 text-xs text-sol-text break-words"><CommentMarkdown content={String(c.text ?? "")} /></div>
    </div>
  );
}

export function HistoryPanel({ live, openRev, onOpen }: { live: LiveHandle; openRev: number | null; onOpen: (rev: number | null) => void }) {
  const versions = useLiveVersions(live.docId);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col h-full" data-live-history>
      <div className="flex items-center gap-2 px-3 h-9 border-b border-sol-border/40 text-xs font-medium text-sol-text-muted">
        <History className="w-3.5 h-3.5" /> History
        <span className="flex-1" />
        {openRev === null && <button type="button" onClick={() => live.history.checkpoint()} className="text-meta text-sol-text-dim hover:text-sol-text">Save version</button>}
      </div>
      <div className="flex-1 overflow-y-auto">
        <button
          type="button"
          onClick={() => onOpen(null)}
          className={`w-full text-left px-3 py-2 border-b border-sol-border/20 ${openRev === null ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-alt/60"}`}
        >
          <div className="text-xs text-sol-text font-medium">Current</div>
        </button>
        {versions.length === 0 && <div className="px-3 py-6 text-center text-xs text-sol-text-dim">No versions yet</div>}
        {versions.map((v) => (
          <div
            key={v._id}
            data-live-version={v.rev}
            onClick={() => onOpen(v.rev)}
            className={`group px-3 py-2 border-b border-sol-border/20 cursor-pointer ${openRev === v.rev ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-alt/60"}`}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs text-sol-text truncate flex-1">{v.label}</span>
              <span className="text-meta font-mono text-sol-text-dim">r{v.rev}</span>
            </div>
            <div className="flex items-center gap-2 text-meta text-sol-text-dim">
              <span className="truncate">{v.by_name}</span>
              <span>{formatRelative(v.at)}</span>
              {v.elements !== undefined && <span>{v.elements} el</span>}
              <span className="flex-1" />
              {openRev === v.rev && (
                <button
                  type="button"
                  data-live-restore={v.rev}
                  disabled={busy}
                  onClick={async (e) => {
                    e.stopPropagation();
                    setBusy(true);
                    try {
                      await live.history.restore(v.rev);
                      onOpen(null);
                    } finally {
                      setBusy(false);
                    }
                  }}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sol-blue/15 text-sol-blue hover:bg-sol-blue/25 disabled:opacity-50"
                >
                  <RotateCcw className="w-3 h-3" /> {busy ? "Restoring" : "Restore"}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
