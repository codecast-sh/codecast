"use client";
// "Ask <owner>" under a sheet's head (cohesive build spec D6): one line into
// the conversation of whoever answers for the object, without leaving the
// sheet or swapping the conversation on the left. The send is the store's
// own (the line lands in the thread at once and rides dispatch), and the
// seat's reply shows under the box once one lands after a send from here
// (before a send, what it last said is the sheet's own Where it stands and
// Now, so the box does not repeat it). Every word is read from the store;
// after a send the thread's own feeder keeps it there. On a person the box
// is "Message <first name>": Enter opens your DM with them, the line as the
// draft, and an empty Enter opens the DM as it stands; a quiet hint says so,
// since unlike Ask it leaves the Org screen.
import { useMemo, useRef, useState } from "react";
import { CornerDownLeft } from "lucide-react";
import { useInboxStore } from "../../../store/inboxStore";
import { SessionPrewarm } from "../../SessionPrewarm";
import { useOpenChatPath } from "../../../hooks/useOpenDm";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { chatDraftKey } from "../../../lib/chatDraftKey";
import { agoOf } from "../../../lib/threadState";
import { cn } from "../../../lib/utils";
import { KeyCap } from "../../KeyboardShortcutsHelp";
import { firstName } from "../../calls/speakers";
import { RoleFace } from "../RoleFace";
import type { Seat } from "./objects";

const BORDER = "var(--sol-border)";

type Said = { text: string; at: number | null };

/** The newest thing the seat said that has words in it. */
function latestSaid(messages: readonly { role?: string; content?: string; timestamp?: number }[] | null | undefined, after = 0): Said | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant" || (m.timestamp ?? 0) <= after) continue;
    const text = (m.content ?? "").trim();
    if (text) return { text, at: m.timestamp ?? null };
  }
  return null;
}

/** The first sentence or line of what was said, short enough for one quote. */
function quoteOf(text: string): string {
  const line = text.replace(/[*_`#>]/g, "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 220 ? `${line.slice(0, 217).trimEnd()}…` : line;
}

export function AskBox({ seat, person }: { seat?: Seat | null; person?: { userId: string; name: string } | null }) {
  const [text, setText] = useState("");
  const [sentAt, setSentAt] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const openChat = useOpenChatPath();
  const now = useCoarseNow(30_000);
  const conv = seat?.conversationId ?? null;

  // What this window holds of the thread, as one string, so a streaming tick
  // that changes nothing said wakes nothing. After a send, only the answer to
  // it: an older word would read as the reply.
  const heldSig = useInboxStore((s) => {
    const said = conv && sentAt ? latestSaid(s.messages[conv] as any, sentAt) : null;
    return said ? `${said.at ?? ""}\u0000${said.text}` : "";
  });
  // The answer shows once the person has asked: before that, what the seat
  // last said is the sheet's own Where it stands and Now, not a second copy.
  const said = useMemo<Said | null>(() => {
    if (!sentAt || !heldSig) return null;
    const [at, ...rest] = heldSig.split("\u0000");
    return { text: rest.join("\u0000"), at: at ? Number(at) : null };
  }, [sentAt, heldSig]);

  if (!seat && !person) return null;
  const name = seat ? seat.name : firstName(person!.name);
  const verb = seat ? "Ask" : "Message";
  const empty = !text.trim();
  const submit = () => {
    const body = text.trim();
    if (!body && seat) return;
    const st = useInboxStore.getState();
    if (seat) {
      st.sendMessage(seat.conversationId, body);
      setSentAt(Date.now());
      setText("");
      return;
    }
    // A person: their DM, with the line (if any) waiting as the draft.
    const channelId = st.openDmChannel([person!.userId]);
    if (body) {
      const key = chatDraftKey(channelId);
      st.setDraft(key, { ...(st.getDraft(key) ?? {}), draft_message: body });
      setText("");
    }
    openChat(`/chat/${channelId}`);
  };

  return (
    <div className="mt-3.5" data-sheet-ask={seat ? "seat" : "person"}>
      {/* After a send, the thread's feeder (its history and live tail) keeps the reply in the store. */}
      {conv && sentAt ? <SessionPrewarm sessionId={conv} /> : null}
      <form
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        onClick={() => input.current?.focus()}
        className="flex items-center gap-2 rounded-[9px] border px-2.5 h-9 cursor-text transition-colors focus-within:border-[color-mix(in_srgb,var(--sol-cyan)_55%,var(--sol-border))]"
        style={{ borderColor: BORDER, background: "var(--sol-bg-alt)" }}
      >
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape" && text) { e.stopPropagation(); setText(""); } }}
          placeholder={`${verb} ${name}…`}
          aria-label={`${verb} ${name}`}
          className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-[var(--sol-text-dim)]"
          style={{ color: "var(--sol-text)" }}
          data-sheet-ask-input
        />
        <button
          type="submit"
          disabled={!!seat && empty}
          className={cn("shrink-0 inline-flex items-center gap-1.5 text-[11px] transition-opacity", seat ? empty && "opacity-50" : "hover:text-[var(--sol-text-muted)]")}
          style={{ color: "var(--sol-text-dim)" }}
          aria-label={seat ? "Send" : `Open your DM with ${name}`}
          data-sheet-ask-submit
        >
          {!seat && <span data-sheet-ask-hint>opens your DM</span>}
          <KeyCap size="xs"><CornerDownLeft className="w-2.5 h-2.5" /></KeyCap>
        </button>
      </form>
      {seat && (sentAt || said) && (
        <div className="mt-1.5 mx-0.5 flex items-start gap-2 text-[12px] leading-snug" style={{ color: "var(--sol-text-muted)" }} data-sheet-ask-reply={said ? "said" : "waiting"}>
          {seat.role ? <RoleFace role={seat.role} size={16} className="mt-px shrink-0" /> : null}
          {said ? (
            <span className="min-w-0">
              {said.at ? <span style={{ color: "var(--sol-text-dim)" }}>{agoOf(Math.max(0, now - said.at))} · </span> : null}
              <q className="[quotes:none]" style={{ color: "var(--sol-text-secondary)" }}>{quoteOf(said.text)}</q>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5" style={{ color: "var(--sol-text-dim)" }} title={`${seat.name}'s answer shows here, and in its thread`}>
              Sent <span className="h-[5px] w-[5px] animate-pulse rounded-full" style={{ background: "var(--sol-text-dim)" }} aria-hidden />
            </span>
          )}
        </div>
      )}
    </div>
  );
}
