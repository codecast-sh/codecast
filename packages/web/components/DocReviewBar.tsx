// Submit surface for doc review mode. While you annotate a document (the same
// quote/comment rail used on messages and plans, keyed under `doc:<id>`), this
// bar floats at the bottom: it shows the pending count, takes an optional cover
// note, and "Send to agent" opens the command palette in pick mode (the doc's
// owning session promoted on top, then every session). On pick it compiles the
// annotations (formatDocFeedback) and posts them to that session as a normal
// user turn via pendingMessages.sendMessageToSession — the same rail cast send
// uses — then clears the batch and leaves review mode.

import { useState, useCallback } from "react";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { nanoid } from "nanoid";
import { useInboxStore } from "../store/inboxStore";
import { cleanTitle } from "../lib/conversationProcessor";
import { formatPendingComments, sortPendingComments, formatDocFeedback } from "../lib/quoteFormat";
import { Send } from "lucide-react";

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
  const sendMessage = useMutation(api.pendingMessages.sendMessageToSession);
  const openCompose = useInboxStore((s) => s.openCompose);

  // Compile the live annotation batch into the same feedback message both the
  // existing-session and new-agent paths post.
  const compileContent = useCallback(() => {
    const pending = (useInboxStore.getState().reviewComments[reviewKey] ?? []).filter(
      (c) => c.body.trim() || c.quote.trim(),
    );
    const batch = formatPendingComments(sortPendingComments(pending));
    return formatDocFeedback(title, docId, batch, note);
  }, [reviewKey, title, docId, note]);

  // Leave review mode and drop the batch — shared epilogue after the feedback
  // has been routed somewhere (an existing session or a fresh agent).
  const finishReview = useCallback(() => {
    useInboxStore.getState().clearReviewComments(reviewKey);
    setNote("");
    onSent?.();
  }, [reviewKey, onSent]);

  const send = useCallback(
    async (conversationId: string, sessionTitle: string) => {
      const content = compileContent();
      try {
        await sendMessage({ conversation_id: conversationId as any, content, client_id: nanoid(10) });
        finishReview();
        toast.success(`Sent to ${cleanTitle(sessionTitle || "session")}`);
      } catch (e: any) {
        toast.error(e?.message?.includes("Unauthorized") ? "You can only send to your own sessions" : "Failed to send feedback");
      }
    },
    [compileContent, finishReview, sendMessage],
  );

  // Hand the feedback to a brand-new agent: open the new-session compose popup
  // with the compiled annotations pre-filled as its first message. The popup owns
  // the blank-session create + project/agent picker, so this is just "open it
  // pre-loaded", and exiting review mode here can't lose anything — the feedback
  // lives in the popup's composer.
  //
  // Seed it with the DOC's own project (project_path/git_root ride on store.docs at
  // runtime — webList spreads the full row, the DocItem type just under-declares it).
  // On the docs page there's no current conversation for the popup to inherit a cwd
  // from, so without this the new agent would start in $HOME (the daemon's pathless
  // fallback) instead of where the doc lives.
  const sendToNew = useCallback(() => {
    const content = compileContent();
    const doc = useInboxStore.getState().docs[docId] as { project_path?: string; git_root?: string } | undefined;
    openCompose(content, { projectPath: doc?.project_path || doc?.git_root });
    finishReview();
  }, [compileContent, finishReview, openCompose, docId]);

  // The doc's owning session (if any) is promoted to the first row so the
  // common case is one keystroke; every other session is a search away.
  const pickTarget = useCallback(() => {
    const owner = ownerConversationId ? useInboxStore.getState().sessions[ownerConversationId] : undefined;
    useInboxStore.getState().openPalette({
      pick: {
        title: "Send feedback to…",
        kinds: ["session"],
        extras: [
          ...(owner
            ? [{ key: "owner", label: cleanTitle(owner.title || "New Session"), description: "This doc's session", icon: "sparkles" as const, primary: true }]
            : []),
          { key: "new", label: "New agent", description: "Start a fresh session with this feedback", icon: "sparkles" as const, primary: !owner },
        ],
        onPick: (t) => {
          if (t.kind === "session") void send(t.id, t.label);
          else if (t.kind === "extra" && t.key === "owner" && owner) void send(owner._id, owner.title || "");
          else sendToNew();
        },
      },
    });
  }, [ownerConversationId, send, sendToNew]);

  return (
    <>
      <div className="sticky bottom-0 z-20 mx-auto max-w-5xl w-full px-10 pb-4 pt-2">
        <div
          className="flex items-center gap-2 rounded-lg border border-sol-yellow/30 backdrop-blur px-3 py-2 shadow-lg shadow-black/20"
          style={{ background: "color-mix(in srgb, var(--sol-bg) 92%, transparent)" }}
        >
          <span className="text-[11px] font-semibold text-sol-yellow whitespace-nowrap">
            {count > 0 ? `${count} note${count === 1 ? "" : "s"}` : "Review"}
          </span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={count > 0 ? "Add a message (optional)…" : "Hover the document to quote a section…"}
            className="flex-1 bg-transparent text-sm text-sol-text placeholder:text-sol-text-dim outline-none"
            onKeyDown={(e) => { if (e.key === "Enter" && count > 0) pickTarget(); }}
          />
          <button
            type="button"
            disabled={count === 0}
            onClick={pickTarget}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-md border transition-colors disabled:opacity-40 disabled:cursor-not-allowed enabled:cursor-pointer border-sol-yellow/40 bg-sol-yellow/10 text-sol-yellow enabled:hover:bg-sol-yellow/20"
          >
            <Send className="w-3 h-3" />
            Send to agent
          </button>
        </div>
      </div>
    </>
  );
}
