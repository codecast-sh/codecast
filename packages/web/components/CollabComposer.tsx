"use client";

import { memo, useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useConvexAuth } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { Send, GitFork, Loader2, Check, ShieldQuestion, Lock, Pencil } from "lucide-react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useInboxStore } from "../store/inboxStore";
import { isConvexId } from "../lib/entityLinks";
import { PresenceFacepile } from "./PresenceFacepile";
import type { ConversationData } from "./ConversationView";

// ── Live composer co-presence ────────────────────────────────────────────────
// Reuses the document-editor presence backend (doc_presence) under a synthetic
// "compose:<conversationId>" id, so each side sees who else is in the box and the
// words they're forming — the "type with me" signal — with no shared OT buffer.
// Broadcast is gated: a collaborator always announces themselves; the owner only
// announces once a collaborator has actually appeared, so a solo session writes
// nothing.

type PresenceRow = {
  user_id: string;
  user_name: string;
  user_color: string;
  draft_text?: string;
};

function useComposerPresence(
  conversationId: string,
  draftText: string,
  opts: { enabled: boolean; forceBroadcast: boolean }
): PresenceRow[] {
  const docId = `compose:${conversationId}`;
  const update = useMutation(api.docSync.updatePresence);
  const remove = useMutation(api.docSync.removePresence);
  // getPresence requires auth — skip it until we're signed in, or it errors during
  // the auth-loading window.
  const present = (useQuery(api.docSync.getPresence, opts.enabled ? { doc_id: docId } : "skip") ?? []) as PresenceRow[];
  const shouldBroadcast = opts.enabled && (opts.forceBroadcast || present.length > 0);

  const draftRef = useRef(draftText);
  draftRef.current = draftText;

  // Heartbeat while broadcasting (keeps the row inside the 30s stale window),
  // and clear it on exit so the other side sees us leave promptly.
  useEffect(() => {
    if (!shouldBroadcast) return;
    update({ doc_id: docId, draft_text: draftRef.current }).catch(() => {});
    const iv = setInterval(() => update({ doc_id: docId, draft_text: draftRef.current }).catch(() => {}), 3000);
    return () => { clearInterval(iv); remove({ doc_id: docId }).catch(() => {}); };
  }, [shouldBroadcast, docId, update, remove]);

  // Snappier than the heartbeat: push shortly after the draft changes.
  useEffect(() => {
    if (!shouldBroadcast) return;
    const t = setTimeout(() => update({ doc_id: docId, draft_text: draftRef.current }).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [draftText, shouldBroadcast, docId, update]);

  return present;
}

function CollabPresenceBar({ present }: { present: PresenceRow[] }) {
  if (present.length === 0) return null;
  const writer = present.find((p) => p.draft_text && p.draft_text.trim());
  const names = present.map((p) => p.user_name).join(", ");
  return (
    <div className="flex items-center gap-2 px-4 py-1 text-[11px] text-sol-text-muted border-t border-sol-border/20 bg-sol-bg-alt/30">
      <PresenceFacepile present={present} />
      {writer ? (
        <span className="flex items-center gap-1 min-w-0">
          <Pencil className="w-3 h-3 text-sol-cyan shrink-0" />
          <b className="text-sol-text shrink-0">{writer.user_name}</b>
          <span className="italic truncate text-sol-text-dim">{writer.draft_text}</span>
        </span>
      ) : (
        <span className="truncate">
          <b className="text-sol-text">{names}</b> {present.length > 1 ? "are" : "is"} here
        </span>
      )}
    </div>
  );
}

// Owner-side presence: mounted above the owner's own composer (only on a shared
// session). Reads the owner's live draft from the store — no MessageInput surgery
// — broadcasts it once a collaborator appears, and shows who's co-writing.
export const OwnerComposerPresence = memo(function OwnerComposerPresence({
  conversationId,
}: {
  conversationId: string;
}) {
  const draft = useInboxStore((s) => s.drafts[conversationId]?.draft_message ?? "") as string;
  const present = useComposerPresence(conversationId, draft, { enabled: true, forceBroadcast: false });
  if (present.length === 0) return null;
  return (
    <div className="mx-auto conv-col px-2 sm:px-4 pb-1">
      <div className="rounded-xl border border-sol-cyan/25 bg-sol-cyan/5 overflow-hidden">
        <CollabPresenceBar present={present} />
      </div>
    </div>
  );
});

// ── Collaboration composer ───────────────────────────────────────────────────
// Shown to a signed-in viewer of a conversation they don't own. Reading is free;
// co-writing the draft is free; *firing* the draft into the owner's live session
// runs commands on their machine, so it takes a one-time per-session grant. This
// composer reflects that grant state — request → wait → send — and always offers
// "fork instead" (the pre-existing path that copies the session as your own).

type SendLevel =
  | "owner" | "team" | "granted" | "requested" | "denied" | "revoked" | "shared" | "anonymous" | "denied_access";

function ownerLabel(conversation: ConversationData): string {
  return (
    conversation.user?.name ||
    conversation.user?.email?.split("@")[0] ||
    "the owner"
  );
}

export const CollabComposer = memo(function CollabComposer({
  conversation,
  onForkReply,
  autoFocusInput,
}: {
  conversation: ConversationData;
  onForkReply: (content: string) => void;
  autoFocusInput?: boolean;
}) {
  const { isAuthenticated } = useConvexAuth();
  const convId = conversation._id as Id<"conversations">;
  // Skip until the conversation is a real server row: a freshly-created
  // optimistic stub is keyed by its session UUID, which the v.id("conversations")
  // validator rejects (crashing the page). A stub has no grants to read anyway.
  const access = useQuery(
    api.collab.mySendAccess,
    isConvexId(conversation._id.toString()) ? { conversation_id: convId } : "skip"
  );
  const requestAccess = useMutation(api.collab.requestSendAccess);
  const sendToSession = useMutation(api.pendingMessages.sendSessionMessage);

  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sentHint, setSentHint] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useMountEffect(() => { if (autoFocusInput) textareaRef.current?.focus(); });
  useWatchEffect(() => {
    const el = textareaRef.current;
    if (el) { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; }
  }, [message]);

  const level: SendLevel = !isAuthenticated
    ? "anonymous"
    : (access?.level as SendLevel) ?? "shared";
  const canSend = level === "granted" || level === "team" || level === "owner";
  const owner = ownerLabel(conversation);

  // Announce myself in the shared box and watch the owner (and any other
  // collaborator) form their draft live.
  const present = useComposerPresence(conversation._id.toString(), message, {
    enabled: isAuthenticated,
    forceBroadcast: true,
  });

  async function handleRequest() {
    if (busy) return;
    setBusy(true);
    try { await requestAccess({ conversation_id: convId }); }
    finally { setBusy(false); }
  }

  async function handleSend() {
    const body = message.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const res = await sendToSession({ to: convId, body });
      setMessage("");
      setSentHint(res?.target_live === false
        ? "Sent — their session looks offline, they'll get it when back"
        : "Sent into the live session");
      setTimeout(() => setSentHint(null), 4000);
    } catch (e: any) {
      setSentHint(e?.message?.includes("granted") ? "Access was revoked" : "Couldn't send");
      setTimeout(() => setSentHint(null), 4000);
    } finally { setBusy(false); }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) handleSend();
      else if (message.trim()) onForkReply(message.trim());
    }
  }

  // The status strip above the box: tells the viewer exactly what their Send does.
  const strip = (() => {
    switch (level) {
      case "granted":
      case "team":
        return { tone: "cyan", icon: <Send className="w-3 h-3" />, text: <>You can send into <b>{owner}</b>'s live session — they run as commands.</> };
      case "requested":
        return { tone: "amber", icon: <Loader2 className="w-3 h-3 animate-spin" />, text: <>Waiting for <b>{owner}</b> to allow you to send…</> };
      case "denied":
      case "revoked":
        return { tone: "muted", icon: <Lock className="w-3 h-3" />, text: <><b>{owner}</b> hasn't granted you send access.</> };
      case "anonymous":
        return { tone: "muted", icon: <Lock className="w-3 h-3" />, text: <>Sign in to co-write and send.</> };
      default: // shared
        return { tone: "cyan", icon: <ShieldQuestion className="w-3 h-3" />, text: <>Co-writing <b>{owner}</b>'s draft. Sending into their live session needs their OK.</> };
    }
  })();

  const toneClass = strip.tone === "cyan"
    ? "text-sol-cyan border-sol-cyan/15 bg-sol-cyan/5"
    : strip.tone === "amber"
    ? "text-amber-400 border-amber-500/15 bg-amber-500/5"
    : "text-sol-text-dim border-sol-border/30 bg-sol-bg-alt/40";

  if (level === "anonymous") {
    return (
      <div className="bg-sol-bg border-t border-sol-border/30">
        <div className="mx-auto conv-col px-2 sm:px-4 py-3 flex items-center justify-between gap-4">
          <span className="text-sol-text-dim text-xs">Sign in to co-write and send into this session.</span>
          <a href="/login" className="text-xs font-medium px-4 py-1.5 rounded-full bg-sol-cyan/15 text-sol-cyan border border-sol-cyan/30 hover:bg-sol-cyan/25 transition-colors whitespace-nowrap">Sign in</a>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-sol-bg">
      <CollabPresenceBar present={present} />
      <div className={`flex items-center gap-2 px-4 py-1.5 text-[11px] border-t ${toneClass}`}>
        <span className="shrink-0">{strip.icon}</span>
        <span className="truncate">{strip.text}</span>
        {sentHint && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-medium text-sol-green shrink-0">
            <Check className="w-3 h-3" />{sentHint}
          </span>
        )}
      </div>
      <form
        onSubmit={(e) => { e.preventDefault(); if (canSend) handleSend(); else if (message.trim()) onForkReply(message.trim()); }}
        className="mx-auto conv-col px-2 sm:px-4 pb-3 pt-1.5"
      >
        <div className={`flex items-end gap-2 border px-4 py-2 rounded-2xl bg-sol-bg-alt shadow-lg ${canSend ? "border-sol-cyan/30" : "border-sol-border/50"}`}>
          <textarea
            ref={textareaRef}
            data-chat-input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={busy}
            placeholder={canSend ? `Message ${owner}'s session…` : "Write together…"}
            rows={1}
            className="flex-1 bg-transparent text-sm placeholder:text-sol-text-dim focus:outline-none disabled:opacity-50 resize-none overflow-hidden leading-relaxed py-1 text-sol-text"
          />

          {/* Fork is always available — copy the session and continue as your own. */}
          {message.trim() && (
            <button
              type="button"
              onClick={() => onForkReply(message.trim())}
              title="Fork this session and reply as your own"
              className="shrink-0 h-8 px-2.5 rounded-full transition-colors flex items-center gap-1 text-xs font-medium border border-sol-violet/40 text-sol-violet hover:bg-sol-violet/15"
            >
              <GitFork className="w-3.5 h-3.5" />Fork
            </button>
          )}

          {canSend ? (
            <button
              type="submit"
              disabled={!message.trim() || busy}
              className={`shrink-0 h-8 px-3 rounded-full transition-colors flex items-center gap-1.5 text-xs font-medium border ${
                !message.trim() || busy
                  ? "border-sol-border/30 text-sol-text-dim/25 cursor-not-allowed"
                  : "border-sol-cyan/50 bg-sol-cyan/20 text-sol-cyan hover:bg-sol-cyan/30 hover:border-sol-cyan"
              }`}
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              Send
            </button>
          ) : level === "requested" ? (
            <button type="button" disabled className="shrink-0 h-8 px-3 rounded-full flex items-center gap-1.5 text-xs font-medium border border-amber-500/40 text-amber-400/80 cursor-default">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />Requested
            </button>
          ) : (
            <button
              type="button"
              onClick={handleRequest}
              disabled={busy}
              className="shrink-0 h-8 px-3 rounded-full transition-colors flex items-center gap-1.5 text-xs font-medium border border-sol-cyan/50 bg-sol-cyan/15 text-sol-cyan hover:bg-sol-cyan/25 disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldQuestion className="w-3.5 h-3.5" />}
              {level === "denied" || level === "revoked" ? "Request again" : "Request to send"}
            </button>
          )}
        </div>
      </form>
    </div>
  );
});

// ── Owner's approve/deny banner ──────────────────────────────────────────────
// Rendered above the owner's own composer. Subscribes to the pending/granted
// collaborators for this session; one tap approves or denies. Approving lights up
// the requester's Send button live (they subscribe via mySendAccess).
export const CollabRequestBanner = memo(function CollabRequestBanner({
  conversationId,
}: {
  conversationId: string;
}) {
  const convId = conversationId as Id<"conversations">;
  // See CollabComposer: skip while the conversation is still an optimistic stub
  // (session-UUID id) — its v.id("conversations") validator would otherwise throw.
  const requests = useQuery(
    api.collab.collabRequests,
    isConvexId(conversationId) ? { conversation_id: convId } : "skip"
  );
  const decide = useMutation(api.collab.decideSendAccess);
  const revoke = useMutation(api.collab.revokeSendAccess);
  const [busyId, setBusyId] = useState<string | null>(null);

  const pending = (requests ?? []).filter((r) => r.status === "requested");
  const granted = (requests ?? []).filter((r) => r.status === "granted");
  if (pending.length === 0 && granted.length === 0) return null;

  async function act(fn: () => Promise<unknown>, id: string) {
    setBusyId(id);
    try { await fn(); } finally { setBusyId(null); }
  }

  return (
    <div className="bg-sol-bg pt-1.5">
      <div className="mx-auto conv-col px-2 sm:px-4 pb-1.5 space-y-1.5">
        {pending.map((r) => (
          <div key={r.grant_id} className="flex items-center gap-2.5 px-3 py-2 rounded-xl border border-sol-cyan/30 bg-sol-cyan/10 shadow-lg">
            <Avatar name={r.grantee_name} image={r.grantee_image} />
            <span className="text-xs text-sol-text flex-1 min-w-0 truncate">
              <b className="text-sol-cyan">{r.grantee_name || "A teammate"}</b> wants to send messages and run commands here
            </span>
            <button
              onClick={() => act(() => decide({ grant_id: r.grant_id, allow: true }), r.grant_id)}
              disabled={busyId === r.grant_id}
              className="shrink-0 h-7 px-3 rounded-full text-xs font-medium border border-sol-green/50 bg-sol-green/20 text-sol-green hover:bg-sol-green/30 disabled:opacity-50 transition-colors"
            >Allow</button>
            <button
              onClick={() => act(() => decide({ grant_id: r.grant_id, allow: false }), r.grant_id)}
              disabled={busyId === r.grant_id}
              className="shrink-0 h-7 px-3 rounded-full text-xs font-medium border border-sol-border text-sol-text-muted hover:bg-sol-bg-alt disabled:opacity-50 transition-colors"
            >Deny</button>
          </div>
        ))}
        {granted.map((r) => (
          <div key={r.grant_id} className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl border border-sol-border/40 bg-sol-bg-alt/50">
            <Avatar name={r.grantee_name} image={r.grantee_image} />
            <span className="text-[11px] text-sol-text-muted flex-1 min-w-0 truncate">
              <b className="text-sol-text">{r.grantee_name || "A teammate"}</b> can send into this session
            </span>
            <button
              onClick={() => act(() => revoke({ grant_id: r.grant_id }), r.grant_id)}
              disabled={busyId === r.grant_id}
              className="shrink-0 h-6 px-2.5 rounded-full text-[11px] font-medium border border-sol-border text-sol-text-dim hover:text-sol-red hover:border-sol-red/40 disabled:opacity-50 transition-colors"
            >Revoke</button>
          </div>
        ))}
      </div>
    </div>
  );
});

function Avatar({ name, image }: { name?: string; image?: string }) {
  if (image) {
    return <img src={image} alt={name || ""} className="w-6 h-6 rounded-full shrink-0 object-cover" />;
  }
  const initial = (name || "?").trim().charAt(0).toUpperCase();
  return (
    <div className="w-6 h-6 rounded-full shrink-0 grid place-items-center bg-sol-cyan/20 text-sol-cyan text-[11px] font-semibold">
      {initial}
    </div>
  );
}
