import { toast } from "sonner";
import { copyToClipboard, shareOrigin } from "../../lib/utils";
import { openForwardToChat } from "../../lib/forwardToChat";
import type { ToolCall, ToolResult } from "./types";
import { cacheLocalDateFormat } from "../../lib/localDateCache";

function messageLink(conversationId: string | undefined, messageId: string) {
  return `${shareOrigin()}/conversation/${conversationId}#msg-${messageId}`;
}

export function copyMessageLink(conversationId: string | undefined, messageId: string) {
  const url = messageLink(conversationId, messageId);
  setTimeout(() => { copyToClipboard(url).then(() => toast.success("Link copied!")).catch(() => toast.error("Failed to copy link")); });
}

export function forwardMessageToChat(conversationId: string | undefined, messageId: string) {
  openForwardToChat({ url: messageLink(conversationId, messageId), label: "message" });
}

/** Ensure a value is a string before rendering as a React child.
 *  Guards against intermittent race conditions where content fields
 *  are briefly non-string during store hydration or subscription updates. */
export function safeString(value: any): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function formatMessagePartsForCopy(
  content: string | undefined,
  toolCalls: ToolCall[] | undefined,
  toolResults: ToolResult[] | undefined,
): string {
  const parts: string[] = [];
  if (content?.trim()) {
    parts.push(content);
  }
  if (toolCalls?.length) {
    for (const tc of toolCalls) {
      let input = tc.input;
      try { input = JSON.stringify(JSON.parse(tc.input), null, 2); } catch {}
      parts.push(`[Tool: ${tc.name}]\n${input}`);
    }
  }
  if (toolResults?.length) {
    for (const tr of toolResults) {
      const errPrefix = tr.is_error ? " (error)" : "";
      parts.push(`[Result${errPrefix}]\n${tr.content}`);
    }
  }
  return parts.join("\n\n");
}

const formatTimestamp = cacheLocalDateFormat((date) => date.toLocaleTimeString([], {
  hour: "2-digit",
  minute: "2-digit",
}));

const formatCalendarDate = cacheLocalDateFormat((date) => date.toLocaleDateString([], { month: "short", day: "numeric" }));

export function formatDuration(startTs: number): string {
  const diff = Date.now() - startTs;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  if (hours < 24) return remainMin ? `${hours}h ${remainMin}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function stripAnsiCodes(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

const ANSI_COLORS: Record<number, string> = {
  30: '#073642', 31: '#dc322f', 32: '#859900', 33: '#b58900',
  34: '#268bd2', 35: '#d33682', 36: '#2aa198', 37: '#eee8d5',
  90: '#586e75', 91: '#cb4b16', 92: '#859900', 93: '#b58900',
  94: '#268bd2', 95: '#6c71c4', 96: '#2aa198', 97: '#fdf6e3',
};

export function renderAnsi(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /\x1b\[([0-9;]*)m/g;
  let lastIndex = 0;
  let currentColor: string | null = null;
  let bold = false;

  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const segment = text.slice(lastIndex, match.index);
      if (currentColor || bold) {
        parts.push(<span key={parts.length} style={{ color: currentColor || undefined, fontWeight: bold ? 700 : undefined }}>{segment}</span>);
      } else {
        parts.push(segment);
      }
    }
    lastIndex = regex.lastIndex;

    const codes = match[1].split(';').map(Number);
    for (const code of codes) {
      if (code === 0) { currentColor = null; bold = false; }
      else if (code === 1) { bold = true; }
      else if (ANSI_COLORS[code]) { currentColor = ANSI_COLORS[code]; }
    }
  }

  if (lastIndex < text.length) {
    const segment = text.slice(lastIndex);
    if (currentColor || bold) {
      parts.push(<span key={parts.length} style={{ color: currentColor || undefined, fontWeight: bold ? 700 : undefined }}>{segment}</span>);
    } else {
      parts.push(segment);
    }
  }

  return parts.length > 0 ? parts : text;
}

export function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return formatCalendarDate(ts);
}

export const formatFullTimestamp = cacheLocalDateFormat((date) => date.toLocaleString([], {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
}));
