// The shell's right-hand panels for a live artifact: comment threads and the
// version history. Both read the store through the live hooks.
import { useMemo, useState } from "react";
import { Check, CornerDownRight, History, RotateCcw, Send } from "lucide-react";
import type { ArtifactElement } from "@codecast/shared/artifacts";
import { useLiveComments, useLiveVersions, type LiveHandle } from "./useLiveArtifact";
import { pickAskTarget, sendAsk, type AskDoc } from "./AskAgentControl";
import { relativeTime } from "../../lib/entityDisplay";
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
  /** A version is open: read the threads, write nothing. */
  readOnly?: boolean;
  doc: AskDoc;
  live: LiveHandle;
  selection: string[];
  focusKey: string | null;
  selectedElements: ArtifactElement[];
  onFocus: (commentKey: string, anchor?: string) => void;
}) {
  const all = useLiveComments(live.docId);
  const [text, setText] = useState("");
  const [toAgent, setToAgent] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const threads = useMemo(() => {
    const roots = all.filter((c) => !c.parent).sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0));
    const replies = new Map<string, ArtifactElement[]>();
    for (const c of all) if (c.parent) replies.set(String(c.parent), [...(replies.get(String(c.parent)) ?? []), c]);
    for (const r of replies.values()) r.sort((a, b) => Number(a.created_at ?? 0) - Number(b.created_at ?? 0));
    return roots.filter((r) => showResolved || !r.resolved).map((root) => ({ root, replies: replies.get(root.key) ?? [] }));
  }, [all, showResolved]);
  const resolvedCount = all.filter((c) => !c.parent && c.resolved).length;
  const anchor = selection[0];

  const post = () => {
    const body = text.trim();
    if (!body) return;
    const key = live.comment({ text: body, ...(anchor ? { anchor } : {}) });
    if (toAgent) {
      pickAskTarget("Send this comment to…", async (target) => {
        const sessionId = await sendAsk(doc, { prompt: body, selected: selectedElements, comment_key: key }, target);
        if (sessionId) live.apply([{ k: key, set: { sent_to: sessionId } }], { layer: "comments", undoable: false });
      });
    }
    setText("");
  };

  return (
    <div className="flex flex-col h-full" data-live-comments>
      <div className="flex items-center gap-2 px-3 h-9 border-b border-sol-border/40 text-xs font-medium text-sol-text-muted">
        Comments
        <span className="text-sol-text-dim">{threads.length}</span>
        <span className="flex-1" />
        {resolvedCount > 0 && (
          <button type="button" onClick={() => setShowResolved((s) => !s)} className="text-meta text-sol-text-dim hover:text-sol-text">
            {showResolved ? "Hide resolved" : `${resolvedCount} resolved`}
          </button>
        )}
      </div>
      {!readOnly && <div className="p-2.5 border-b border-sol-border/30">
        <textarea
          data-live-comment-input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); post(); } }}
          rows={2}
          placeholder={anchor ? `Comment on ${anchor}` : "Comment"}
          className="w-full resize-none bg-sol-bg-alt rounded-md px-2.5 py-2 text-sm text-sol-text placeholder:text-sol-text-dim outline-none border border-sol-border/40 focus:border-sol-blue/50"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-meta text-sol-text-muted cursor-pointer select-none">
            <input type="checkbox" data-live-comment-agent checked={toAgent} onChange={(e) => setToAgent(e.target.checked)} className="accent-[var(--sol-violet)]" />
            Send to agent
          </label>
          <span className="flex-1" />
          <button type="button" disabled={!text.trim()} onClick={post} className="inline-flex items-center gap-1 h-6 px-2 rounded text-xs bg-sol-blue/15 text-sol-blue hover:bg-sol-blue/25 disabled:opacity-40">
            <Send className="w-3 h-3" /> Post
          </button>
        </div>
      </div>}
      <div className="flex-1 overflow-y-auto">
        {threads.length === 0 && <div className="px-3 py-6 text-center text-xs text-sol-text-dim">No comments</div>}
        {threads.map(({ root, replies }) => (
          <Thread key={root.key} live={live} root={root} replies={replies} focused={!readOnly && focusKey === root.key} onFocus={onFocus} />
        ))}
      </div>
    </div>
  );
}

function Thread({ live, root, replies, focused, onFocus }: { live: LiveHandle; root: ArtifactElement; replies: ArtifactElement[]; focused: boolean; onFocus: (k: string, anchor?: string) => void }) {
  const [reply, setReply] = useState("");
  return (
    <div
      data-live-thread={root.key}
      onClick={() => onFocus(root.key, root.anchor ? String(root.anchor) : undefined)}
      className={`px-3 py-2.5 border-b border-sol-border/20 cursor-pointer ${focused ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-alt/60"} ${root.resolved ? "opacity-60" : ""}`}
    >
      <CommentLine c={root} />
      {replies.map((r) => (
        <div key={r.key} className="mt-2 pl-3 border-l border-sol-border/40"><CommentLine c={r} /></div>
      ))}
      {focused && (
        <div className="mt-2 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <CornerDownRight className="w-3 h-3 text-sol-text-dim shrink-0" />
          <input
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && reply.trim()) { live.comment({ text: reply.trim(), parent: root.key }); setReply(""); }
            }}
            placeholder="Reply"
            className="flex-1 min-w-0 bg-transparent text-xs text-sol-text placeholder:text-sol-text-dim outline-none"
          />
          <button
            type="button"
            title={root.resolved ? "Reopen" : "Resolve"}
            onClick={() => live.apply([{ k: root.key, set: { resolved: root.resolved ? null : true } }], { layer: "comments", undoable: false })}
            className="p-1 rounded text-sol-text-dim hover:text-sol-green"
          >
            <Check className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function CommentLine({ c }: { c: ArtifactElement }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-meta">
        <span className={`font-medium ${String(c.author ?? "").startsWith("s:") ? "text-sol-violet" : "text-sol-text"}`}>{String(c.author_name ?? "Someone")}</span>
        {c.anchor ? <span className="font-mono text-sol-text-dim truncate">{String(c.anchor)}</span> : null}
        <span className="flex-1" />
        <span className="text-sol-text-dim">{formatRelative(Number(c.created_at ?? c.at ?? 0))}</span>
      </div>
      <div className="mt-0.5 text-xs text-sol-text whitespace-pre-wrap break-words">{String(c.text ?? "")}</div>
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
