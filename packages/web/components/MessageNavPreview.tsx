"use client";

// The pieces of a message navigator row that both its list and its hover card
// draw: who sent it (face, tag, color) and where a machine row came from.
import { useState, useRef, useLayoutEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { MessagePromptPreview } from "./MessagePromptPreview";
import { AvatarImg } from "../lib/avatarCache";
import { api } from "@codecast/convex/convex/_generated/api";
import {
  formatTimeAgo,
  navigatorRowBody,
  authorToneName,
  type HiddenKind,
  type NavigatorRow,
  type NavigatorAuthor,
} from "../lib/messageNavigator";
import { resolveSessionTitle } from "../lib/sessionTitle";
import { isConvexId, useInboxStore } from "../store/inboxStore";
import { shareTokenArg } from "../lib/shareTokenScope";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";

const SHORT_ID_RE = /^[a-z0-9]{7}$/;

// Source label for a machine-delivered row. A session source that the store
// couldn't resolve (sender pruned/dismissed locally) still renders as a bare
// short id here — resolve it server-side the same way EntityIdPill does.
export function MachineSourceLabel({ kind, source }: { kind: HiddenKind; source: string }) {
  const needsLookup = kind === "session" && SHORT_ID_RE.test(source);
  const resolved = useQueryNoThrow(api.conversations.webGet, needsLookup ? { short_id: source } : "skip").data;
  return <>{(needsLookup && resolved?.title) || source}</>;
}

export function MachineKindIcon({ kind }: { kind: HiddenKind }) {
  const d =
    kind === "schedule"
      ? "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
      : kind === "session"
      ? "M13 7l5 5m0 0l-5 5m5-5H6"
      : kind === "continue"
      ? "M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
      : kind === "chat"
      ? "M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z"
      : "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z";
  return (
    <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
    </svg>
  );
}

// A person's color, by their tone in the conversation (resolveNavigatorAuthors):
// the owner is the unmarked voice, everyone else gets one hue, shared by their
// rail ticks and their face so the two read as the same person.
export function authorToneColor(tone: number): string | undefined {
  const name = authorToneName(tone);
  return name ? `var(--sol-${name})` : undefined;
}

/** A sender's face, square like the transcript's (UserIcon); their initial on
 *  their color when they have no picture. */
export function AuthorFace({ author, size }: { author: NavigatorAuthor; size: number }) {
  const fallback = (
    <span
      className="rounded-[3px] grid place-items-center font-semibold text-sol-bg shrink-0 leading-none"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.62), backgroundColor: authorToneColor(author.tone) ?? "var(--sol-blue)" }}
    >
      {author.name.charAt(0).toUpperCase()}
    </span>
  );
  return author.image ? (
    <AvatarImg src={author.image} alt="" className="rounded-[3px] object-cover shrink-0" style={{ width: size, height: size }} fallback={fallback} />
  ) : fallback;
}

/** Who sent a row, the way the row's header line says it: face, then name. */
export function AuthorTag({ author, strong }: { author: NavigatorAuthor; strong?: boolean }) {
  return (
    <span className="flex items-center gap-1.5 min-w-0" title={author.label === "You" ? `You (${author.name})` : author.name}>
      <AuthorFace author={author} size={14} />
      <span className={`text-meta font-medium truncate ${strong ? "text-sol-text" : "text-sol-text-muted"}`}>{author.label}</span>
    </span>
  );
}

export function possessive(author: NavigatorAuthor): string {
  return author.label === "You" ? "your" : `${author.label}\u2019s`;
}

// Hover card for one navigator row. The row carries a server snippet (capped
// at NAV_ROW_SNIPPET_CHARS); the card resolves the full body on demand — the
// loaded message page first, then one `messages.webGet` — and truncates by
// viewport height instead of by character count: collapsed it fills up to
// 60% of the window with a fade, expanded it takes the whole window height
// and scrolls. The card shifts up when its anchor would push it off screen.
export function HoverPreview({ message, author, conversationId, rect, onMouseEnter, onMouseLeave, onDropdownEnter, onDropdownLeave }: { message: NavigatorRow; author?: NavigatorAuthor; conversationId: string; rect: DOMRect; onMouseEnter: () => void; onMouseLeave: () => void; onDropdownEnter: () => void; onDropdownLeave: () => void }) {
  "use no memo"; // formatTimeAgo() reads the clock as this renders; compiled, the time shown would stop moving.
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const [top, setTop] = useState(() => Math.max(8, rect.top - 20));
  const cardRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const pageContent = useInboxStore((s) =>
    message.clipped ? s.messages[conversationId]?.find((m) => m._id === message._id)?.content : undefined
  );
  const { data: fetched } = useQueryNoThrow(
    api.messages.webGet,
    message.clipped && pageContent === undefined && isConvexId(conversationId)
      ? { id: message._id, ...shareTokenArg(conversationId) }
      : "skip",
  );
  const fullContent = message.clipped ? pageContent ?? fetched?.message?.content : undefined;
  const loadingBody = message.clipped && fullContent === undefined;
  const body = useMemo(() => {
    const text = navigatorRowBody(message, fullContent, resolveSessionTitle);
    return loadingBody && text === message.display ? `${text}\u2026` : text;
  }, [message, fullContent, loadingBody]);

  const previewWidth = Math.min(expanded ? 760 : 420, window.innerWidth - 16);
  const bridgePad = 20;
  const left = Math.max(8, rect.left - previewWidth - bridgePad);
  const maxHeight = expanded ? window.innerHeight - 16 : Math.round(window.innerHeight * 0.6);

  useLayoutEffect(() => {
    const card = cardRef.current;
    const bodyEl = bodyRef.current;
    if (!card || !bodyEl) return;
    setOverflows(bodyEl.scrollHeight > bodyEl.clientHeight + 1);
    const anchored = Math.max(8, rect.top - 20);
    setTop(Math.max(8, Math.min(anchored, window.innerHeight - card.offsetHeight - 8)));
  }, [body, message.images, expanded, previewWidth, rect.top]);

  const showFooter = expanded || overflows || loadingBody;

  return createPortal(
    <div
      className="fixed z-[10000]"
      style={{ top, left, width: previewWidth + bridgePad, paddingRight: bridgePad }}
      onMouseEnter={() => { onMouseEnter(); onDropdownEnter(); }}
      onMouseLeave={() => { onMouseLeave(); onDropdownLeave(); }}
    >
      <div
        ref={cardRef}
        className="bg-sol-bg border border-sol-border/40 rounded-lg shadow-2xl flex flex-col"
        style={{ width: previewWidth, maxHeight }}
      >
        <div className="flex items-center gap-2 p-3 pb-1 flex-shrink-0">
          {message.kind === "user" ? (
            <>
              <span className="text-meta text-sol-text-dim tabular-nums">#{message.originalIndex + 1}</span>
              {author && <><span className="text-sol-text-dim/30">·</span><AuthorTag author={author} strong /></>}
            </>
          ) : (
            <span className="text-meta text-sol-violet/80 flex items-center gap-1">
              <MachineKindIcon kind={message.kind} />
              {message.source && <MachineSourceLabel kind={message.kind} source={message.source} />}
            </span>
          )}
          <span className="text-sol-text-dim/30">·</span>
          <span className="text-sol-text-dim text-meta">{formatTimeAgo(message.timestamp)}</span>
          {message.commentCount > 0 && (
            <span className="text-meta text-sol-cyan flex items-center gap-0.5">
              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
              </svg>
              {message.commentCount}
            </span>
          )}
        </div>
        <div className="relative flex-1 min-h-0 flex flex-col">
          <div ref={bodyRef} className={`px-3 pb-3 flex-1 min-h-0 ${expanded ? "overflow-y-auto" : "overflow-hidden"}`}>
            <MessagePromptPreview content={body} images={message.images} messageId={message._id} variant="preview" textClassName="text-[13px] text-sol-text whitespace-pre-wrap leading-relaxed" />
          </div>
          {!expanded && overflows && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-sol-bg to-transparent" />
          )}
        </div>
        {showFooter && (
          <div className="flex-shrink-0 border-t border-sol-border/30 px-3 py-1.5 flex items-center justify-between gap-2">
            <span className="text-meta text-sol-text-dim">{loadingBody ? "Loading full message" : `${body.length.toLocaleString()} chars`}</span>
            {(expanded || overflows) && (
              <button
                type="button"
                className="text-meta text-sol-cyan hover:text-sol-text transition-colors"
                onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
              >
                {expanded ? "Show less" : "Show more"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
