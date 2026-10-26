"use client";

// The composer an anonymous viewer of a share link gets when the owner lets
// guests suggest messages (convex sessionGuests.ts). A guest gives a name
// once; their browser keeps the guest pass. What they write waits for the
// owner, and each suggestion shows where it stands: waiting, sent, dismissed.
//
// Guests have no account, so nothing here goes through the store's dispatch
// (it needs a signed-in user): the guest's own rows come straight from
// guestState, and a send shows as "sending" until that query has it.
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Check, Loader2, Send, X } from "lucide-react";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { useHeldTextareaRef } from "../lib/holdTextareaTextNode";
import { useWatchEffect } from "../hooks/useWatchEffect";
import type { ConversationData } from "./conversation/types";

type GuestPass = { guest_id: string; secret: string; name: string };
type Suggestion = { _id: string; body: string; status: "pending" | "sent" | "dismissed" | "sending"; created_at: number };

const passKey = (conversationId: string) => `codecast:guest-pass:${conversationId}`;

function readPass(conversationId: string): GuestPass | null {
  try {
    const raw = localStorage.getItem(passKey(conversationId));
    return raw ? (JSON.parse(raw) as GuestPass) : null;
  } catch {
    return null;
  }
}

// The few most recent are what a guest needs to see where their words went.
const SHOWN = 4;

export function GuestSuggestComposer({ conversation, shareToken }: { conversation: ConversationData; shareToken: string }) {
  const conversationId = conversation._id.toString();
  const owner = conversation.user?.name || conversation.user?.email?.split("@")[0] || "the owner";
  const [pass, setPass] = useState<GuestPass | null>(() => readPass(conversationId));
  const state = useQueryNoThrow(api.sessionGuests.guestState, {
    conversation_id: conversationId,
    share_token: shareToken,
    ...(pass ? { guest_id: pass.guest_id, secret: pass.secret } : {}),
  }).data;
  const join = useMutation(api.sessionGuests.joinAsGuest);
  const suggest = useMutation(api.sessionGuests.suggest);
  const withdraw = useMutation(api.sessionGuests.withdraw);

  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState<Suggestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const textareaRef = useHeldTextareaRef();
  useWatchEffect(() => {
    const el = textareaRef.current;
    if (el) { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; }
  }, [message]);

  if (!state?.open) return null;

  // A pass the server no longer honours (a rotated link) asks for a name again.
  const guest = pass && state.guest ? { ...pass, name: state.guest.name } : null;
  const creds = guest ? { conversation_id: conversationId, share_token: shareToken, guest_id: guest.guest_id, secret: guest.secret } : null;

  async function handleJoin() {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await join({ conversation_id: conversationId, share_token: shareToken, name });
      const next = { guest_id: String(res.guest_id), secret: res.secret, name: res.name };
      localStorage.setItem(passKey(conversationId), JSON.stringify(next));
      setPass(next);
      requestAnimationFrame(() => textareaRef.current?.focus());
    } catch (e: any) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleSuggest() {
    const body = message.trim();
    if (!body || !creds) return;
    const local: Suggestion = { _id: `sending:${Date.now()}`, body, status: "sending", created_at: Date.now() };
    setSending((s) => [...s, local]);
    setMessage("");
    setError(null);
    try {
      await suggest({ ...creds, body });
    } catch (e: any) {
      setMessage((m) => m || body);
      setError(errorText(e));
    } finally {
      setSending((s) => s.filter((r) => r._id !== local._id));
    }
  }

  const rows: Suggestion[] = [...(state.suggestions as Suggestion[]), ...sending].slice(-SHOWN);

  if (!guest) {
    return (
      <div className="bg-sol-bg border-t border-sol-border/30">
        <form
          onSubmit={(e) => { e.preventDefault(); handleJoin(); }}
          className="mx-auto conv-col px-2 sm:px-4 py-3 flex items-center gap-2"
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            maxLength={60}
            autoComplete="name"
            className="flex-1 min-w-0 h-8 px-3 rounded-full bg-sol-bg-alt border border-sol-border/50 text-sm text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan/50"
          />
          <button
            type="submit"
            disabled={!name.trim() || busy}
            className="shrink-0 h-8 px-4 rounded-full text-xs font-medium border border-sol-cyan/50 bg-sol-cyan/15 text-sol-cyan hover:bg-sol-cyan/25 disabled:opacity-50 transition-colors"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Suggest messages"}
          </button>
        </form>
        {error && <div className="mx-auto conv-col px-4 pb-2 text-[11px] text-sol-red">{error}</div>}
      </div>
    );
  }

  return (
    <div className="bg-sol-bg" data-guest-composer>
      {rows.length > 0 && (
        <div className="mx-auto conv-col px-2 sm:px-4 pt-1.5 space-y-1">
          {rows.map((r) => (
            <div key={r._id} className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-sol-border/40 bg-sol-bg-alt/50 text-xs">
              <span className="flex-1 min-w-0 truncate text-sol-text" title={r.body}>{r.body}</span>
              <StatusChip status={r.status} />
              {r.status === "pending" && creds && (
                <button
                  onClick={() => withdraw({ ...creds, suggestion_id: r._id }).catch(() => {})}
                  title="Take it back"
                  aria-label="Take it back"
                  className="shrink-0 p-0.5 rounded text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt transition-colors"
                ><X className="w-3.5 h-3.5" /></button>
              )}
            </div>
          ))}
        </div>
      )}
      <form
        onSubmit={(e) => { e.preventDefault(); handleSuggest(); }}
        className="mx-auto conv-col px-2 sm:px-4 pb-3 pt-1.5"
      >
        <div className="flex items-end gap-2 border px-4 py-2 rounded-2xl bg-sol-bg-alt shadow-lg border-sol-violet/30">
          <textarea
            ref={textareaRef}
            data-chat-input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSuggest(); }
            }}
            placeholder={`Suggest a message for ${owner} to send…`}
            rows={1}
            className="flex-1 min-w-0 bg-transparent text-sm placeholder:text-sol-text-dim focus:outline-none resize-none overflow-hidden leading-relaxed py-1 text-sol-text"
          />
          <button
            type="submit"
            disabled={!message.trim()}
            className={`shrink-0 h-8 px-3 rounded-full transition-colors flex items-center gap-1.5 text-xs font-medium border ${
              !message.trim()
                ? "border-sol-border/30 text-sol-text-dim/25 cursor-not-allowed"
                : "border-sol-violet/50 bg-sol-violet/20 text-sol-violet hover:bg-sol-violet/30"
            }`}
          >
            <Send className="w-3.5 h-3.5" />Suggest
          </button>
        </div>
        <div className="flex items-center justify-between px-2 pt-1 text-[11px] text-sol-text-dim">
          <span>as <b className="text-sol-text-muted">{guest.name}</b></span>
          {error && <span className="text-sol-red truncate">{error}</span>}
        </div>
      </form>
    </div>
  );
}

function StatusChip({ status }: { status: Suggestion["status"] }) {
  switch (status) {
    case "sending":
      return <span className="shrink-0 inline-flex items-center gap-1 text-[10px] text-sol-text-dim"><Loader2 className="w-3 h-3 animate-spin" />Sending</span>;
    case "pending":
      return <span className="shrink-0 text-[10px] font-medium text-sol-yellow">Waiting</span>;
    case "sent":
      return <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-medium text-sol-green"><Check className="w-3 h-3" />Sent</span>;
    default:
      return <span className="shrink-0 text-[10px] text-sol-text-dim">Dismissed</span>;
  }
}

function errorText(e: any): string {
  const raw = String(e?.data ?? e?.message ?? "Couldn't send");
  // Convex prefixes server errors with the request id and function name.
  const m = raw.match(/Uncaught Error: (.*?)(?:\n|$)/);
  return (m ? m[1] : raw).slice(0, 160);
}
