import { useEffect, useRef, useState, type RefObject } from "react";
import { Send } from "lucide-react";
import { chatPlainText, formatChatCopy, type ChatCopyPart } from "../../lib/chatCopy";
import { sendToSession } from "../../lib/sendToSession";
import { useInboxStore } from "../../store/inboxStore";
import type { ChatMessageView } from "./chatTypes";

// Selecting across chat rows: copy writes each person's lines under one header
// instead of the row chrome the browser would copy, and a "Send to session"
// button sits over the selection, opening the palette to pick where it goes.

const ROW = "[data-message-id]";
const BODY = ".ch-msg-body";

function rangeOf(node: Node): Range {
  const r = document.createRange();
  r.selectNodeContents(node);
  return r;
}

/** Rendered text of part of a node, with its paragraph breaks. innerText
 *  needs layout, so the fragment is measured off screen for a moment. */
function fragmentText(range: Range): string {
  const holder = document.createElement("div");
  holder.style.cssText = "position:fixed;left:-99999px;top:0;white-space:pre-wrap";
  holder.appendChild(range.cloneContents());
  document.body.appendChild(holder);
  const text = holder.innerText;
  holder.remove();
  return text;
}

/** The selection as chat lines, or null when the browser's own copy is right:
 *  nothing of a message is selected, or the selection sits inside one body. */
export function selectedChatParts(container: HTMLElement, byId: Map<string, ChatMessageView>): ChatCopyPart[] | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const startBody = start?.closest(BODY);
  if (startBody && startBody.contains(range.endContainer)) return null;

  const parts: ChatCopyPart[] = [];
  for (const row of Array.from(container.querySelectorAll<HTMLElement>(ROW))) {
    if (!range.intersectsNode(row)) continue;
    const msg = byId.get(row.dataset.messageId ?? "");
    if (!msg || msg.deletedAt || msg.agentStatus === "thinking" || msg.agentStatus === "streaming") continue;
    const body = row.querySelector(BODY);
    let text = chatPlainText(msg.content);
    if (body) {
      const whole = rangeOf(body);
      const before = range.compareBoundaryPoints(Range.START_TO_START, whole) > 0;
      const after = range.compareBoundaryPoints(Range.END_TO_END, whole) < 0;
      if (before || after) {
        if (!range.intersectsNode(body)) continue;
        const part = range.cloneRange();
        if (!before) part.setStart(whole.startContainer, whole.startOffset);
        if (!after) part.setEnd(whole.endContainer, whole.endOffset);
        text = fragmentText(part);
      }
    }
    if (text.trim()) parts.push({ author: msg.author.name, createdAt: msg.createdAt, text });
  }
  return parts.length ? parts : null;
}

function channelLabel(channelId?: string): string | null {
  if (!channelId) return null;
  const ch = useInboxStore.getState().chatChannels[channelId] as { name?: string; kind?: string } | undefined;
  if (!ch) return null;
  return ch.kind === "dm" ? "a direct message" : ch.name ? `#${ch.name}` : null;
}

function openSendPicker(excerpt: string, channelId?: string) {
  const place = channelLabel(channelId);
  useInboxStore.getState().openPalette({
    pick: {
      title: "Send to a session",
      kinds: ["session"],
      notePlaceholder: "What should the agent do with it (optional)",
      confirmLabel: "Send",
      onPick: (t, r) => {
        if (t.kind !== "session") return;
        const quoted = `${place ? `From ${place}:\n\n` : ""}${excerpt}`;
        sendToSession(t.id, r.note ? `${r.note}\n\n${quoted}` : quoted);
        useInboxStore.getState().openSidePanel(t.id);
      },
    },
  });
}

export function useChatSelection(
  containerRef: RefObject<HTMLDivElement | null>,
  messages: ChatMessageView[],
  channelId?: string,
) {
  const byIdRef = useRef(new Map<string, ChatMessageView>());
  byIdRef.current = new Map(messages.map((m) => [m.id, m]));
  const [pop, setPop] = useState<{ top: number; left: number; text: string } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onCopy = (e: ClipboardEvent) => {
      const parts = selectedChatParts(el, byIdRef.current);
      const out = parts && formatChatCopy(parts);
      if (!out || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", out.text);
      e.clipboardData.setData("text/html", out.html);
    };
    // Shown when a gesture ends with something selected, so the button does
    // not chase the pointer while the selection is still being dragged.
    const show = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return setPop(null);
      const range = sel.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) return setPop(null);
      const parts: ChatCopyPart[] | null =
        selectedChatParts(el, byIdRef.current) ?? oneBodyPart(range, byIdRef.current);
      const out = parts && formatChatCopy(parts);
      if (!out) return setPop(null);
      const wrap = el.parentElement!.getBoundingClientRect();
      const rect = range.getBoundingClientRect();
      setPop({
        top: Math.max(4, rect.top - wrap.top - 34),
        left: Math.min(Math.max(8, rect.left - wrap.left + rect.width / 2), wrap.width - 8),
        text: out.text,
      });
    };
    const onUp = () => setTimeout(show, 0);
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setPop(null);
    };
    const hide = () => setPop(null);
    el.addEventListener("copy", onCopy);
    el.addEventListener("mouseup", onUp);
    el.addEventListener("keyup", onUp);
    el.addEventListener("scroll", hide, { passive: true });
    document.addEventListener("selectionchange", onSelChange);
    return () => {
      el.removeEventListener("copy", onCopy);
      el.removeEventListener("mouseup", onUp);
      el.removeEventListener("keyup", onUp);
      el.removeEventListener("scroll", hide);
      document.removeEventListener("selectionchange", onSelChange);
    };
  }, [containerRef]);

  const button = pop ? (
    <button
      type="button"
      className="ch-sel-send"
      style={{ top: pop.top, left: pop.left }}
      // Keeps the selection: a press that moved focus would collapse it first.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const text = pop.text;
        setPop(null);
        window.getSelection()?.removeAllRanges();
        openSendPicker(text, channelId);
      }}
    >
      <Send className="w-3 h-3" aria-hidden="true" />
      Send to session
    </button>
  ) : null;

  return button;
}

/** A selection inside one message: its words, under that message's header. */
function oneBodyPart(range: Range, byId: Map<string, ChatMessageView>): ChatCopyPart[] | null {
  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const row = start?.closest<HTMLElement>(ROW);
  const msg = row && byId.get(row.dataset.messageId ?? "");
  if (!msg) return null;
  const text = fragmentText(range);
  return text.trim() ? [{ author: msg.author.name, createdAt: msg.createdAt, text }] : null;
}
