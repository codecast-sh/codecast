// Submit surface for doc review mode. While you annotate a document (the same
// quote/comment rail used on messages and plans, keyed under `doc:<id>`), this
// bar floats at the bottom: it shows the pending count, takes an optional cover
// note, and "Send to agent" opens a session picker. On pick it compiles the
// annotations (formatDocFeedback) and posts them to that session as a normal
// user turn via pendingMessages.sendMessageToSession — the same rail cast send
// uses — then clears the batch and leaves review mode.

import { useMemo, useState, useCallback } from "react";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { nanoid } from "nanoid";
import { useInboxStore, getProjectName, type InboxSession } from "../store/inboxStore";
import { cleanTitle } from "../lib/conversationProcessor";
import { LivenessDot, sessionLivenessState } from "./LivenessDot";
import { formatPendingComments, sortPendingComments, formatDocFeedback } from "../lib/quoteFormat";
import { Send, X, Search } from "lucide-react";

const api = _api as any;

export function DocReviewBar({
  reviewKey,
  docId,
  title,
  ownerConversationId,
  onSent,
}: {
  reviewKey: string;
  docId: string;
  title: string;
  ownerConversationId?: string;
  onSent?: () => void;
}) {
  const comments = useInboxStore((s) => s.reviewComments[reviewKey]);
  const count = comments?.length ?? 0;
  const [note, setNote] = useState("");
  const [picking, setPicking] = useState(false);
  const sendMessage = useMutation(api.pendingMessages.sendMessageToSession);

  const send = useCallback(
    async (conversationId: string, sessionTitle: string) => {
      const pending = (useInboxStore.getState().reviewComments[reviewKey] ?? []).filter(
        (c) => c.body.trim() || c.quote.trim(),
      );
      const batch = formatPendingComments(sortPendingComments(pending));
      const content = formatDocFeedback(title, docId, batch, note);
      setPicking(false);
      try {
        await sendMessage({ conversation_id: conversationId as any, content, client_id: nanoid(10) });
        useInboxStore.getState().clearReviewComments(reviewKey);
        setNote("");
        toast.success(`Sent to ${cleanTitle(sessionTitle || "session")}`);
        onSent?.();
      } catch (e: any) {
        toast.error(e?.message?.includes("Unauthorized") ? "You can only send to your own sessions" : "Failed to send feedback");
      }
    },
    [reviewKey, title, docId, note, sendMessage, onSent],
  );

  return (
    <>
      <div className="sticky bottom-0 z-20 mx-auto max-w-5xl w-full px-10 pb-4 pt-2">
        <div className="flex items-center gap-2 rounded-lg border border-sol-yellow/30 bg-sol-bg/95 backdrop-blur px-3 py-2 shadow-lg shadow-black/20">
          <span className="text-[11px] font-semibold text-sol-yellow whitespace-nowrap">
            {count > 0 ? `${count} note${count === 1 ? "" : "s"}` : "Review"}
          </span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={count > 0 ? "Add a message (optional)…" : "Hover the document to quote a section…"}
            className="flex-1 bg-transparent text-sm text-sol-text placeholder:text-sol-text-dim outline-none"
            onKeyDown={(e) => { if (e.key === "Enter" && count > 0) setPicking(true); }}
          />
          <button
            type="button"
            disabled={count === 0}
            onClick={() => setPicking(true)}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-md border transition-colors disabled:opacity-40 disabled:cursor-not-allowed enabled:cursor-pointer border-sol-yellow/40 bg-sol-yellow/10 text-sol-yellow enabled:hover:bg-sol-yellow/20"
          >
            <Send className="w-3 h-3" />
            Send to agent
          </button>
        </div>
      </div>
      {picking && (
        <SessionPicker
          ownerConversationId={ownerConversationId}
          onClose={() => setPicking(false)}
          onPick={send}
        />
      )}
    </>
  );
}

// Click/search picker over the user's own sessions. The doc's owning session (if
// any) is pinned to the top and auto-focused so the common case is one click.
function SessionPicker({
  ownerConversationId,
  onClose,
  onPick,
}: {
  ownerConversationId?: string;
  onClose: () => void;
  onPick: (conversationId: string, title: string) => void;
}) {
  const sessions = useInboxStore((s) => s.sessions);
  const currentUserId = useInboxStore((s) => s.currentUser?._id);
  const [q, setQ] = useState("");

  const rows = useMemo(() => {
    const all = (Object.values(sessions) as InboxSession[]).filter(
      (s) => !currentUserId || !s.user_id || String(s.user_id) === String(currentUserId),
    );
    const query = q.trim().toLowerCase();
    const filtered = query
      ? all.filter((s) => cleanTitle(s.title || "").toLowerCase().includes(query))
      : all;
    filtered.sort((a, b) => {
      if (a._id === ownerConversationId) return -1;
      if (b._id === ownerConversationId) return 1;
      return (b.updated_at || 0) - (a.updated_at || 0);
    });
    return filtered.slice(0, 40);
  }, [sessions, currentUserId, q, ownerConversationId]);

  return (
    <div className="fixed inset-0 z-[9999] flex items-start justify-center pt-[12vh] bg-black/40" onClick={onClose}>
      <div
        className="w-[440px] max-h-[min(520px,72vh)] flex flex-col rounded-lg border border-sol-border/60 bg-sol-bg/95 backdrop-blur-xl shadow-2xl shadow-black/40 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-2 border-b border-sol-border/40 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-sol-text-dim">Send feedback to…</span>
          <button onClick={onClose} className="text-sol-text-dim hover:text-sol-text"><X className="w-3.5 h-3.5" /></button>
        </div>
        <div className="px-3 py-2 border-b border-sol-border/30 flex items-center gap-2">
          <Search className="w-3.5 h-3.5 text-sol-text-dim flex-shrink-0" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") onClose(); else if (e.key === "Enter" && rows[0]) onPick(rows[0]._id, rows[0].title || ""); }}
            placeholder="Search sessions…"
            className="flex-1 bg-transparent text-sm text-sol-text placeholder:text-sol-text-dim outline-none"
          />
        </div>
        <div className="flex-1 overflow-y-auto py-1 scrollbar-auto">
          {rows.length === 0 && <div className="px-3 py-6 text-center text-xs text-sol-text-dim">No sessions found</div>}
          {rows.map((s) => {
            const project = getProjectName(s.git_root, s.project_path);
            const isOwner = s._id === ownerConversationId;
            return (
              <button
                key={s._id}
                onClick={() => onPick(s._id, s.title || "")}
                className="w-full text-left mx-1 px-3 py-2 rounded-md flex items-center gap-3 border border-transparent hover:bg-sol-cyan/15 hover:border-sol-cyan/30 transition-colors"
              >
                <LivenessDot state={sessionLivenessState(s)} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate text-sol-text/90">{cleanTitle(s.title || "New Session")}</div>
                  {project !== "unknown" && <div className="text-[11px] text-sol-cyan/70 truncate">{project}</div>}
                </div>
                {isOwner && <span className="text-[10px] text-sol-yellow/80 flex-shrink-0">this doc</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
