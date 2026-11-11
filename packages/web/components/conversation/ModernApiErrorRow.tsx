import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { TriangleAlert } from "lucide-react";
import { copyToClipboard } from "../../lib/utils";
import { failureLine } from "../../lib/modernRow";
import { formatFullTimestamp, formatRelativeTime } from "../../lib/conversationFormat";
import { useInboxStore } from "../../store/inboxStore";
import { Button } from "../ui/button";
import type { ParsedApiError } from "./types";

// A failed turn in the Modern style (ApiErrorCard branches here): one row in
// the Error colour, the heading as its verb and the first line of what failed
// beside it, and the fix the app already has as a button on the row: Retry
// (sends `continue`, what the banner tells the person to type), Compact or
// Clear for a full context, the sign-in command for an expired login. The
// explanation, the request id and the whole message open under the chevron.
// Once the session moved past it the row goes quiet and says "resolved".

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

export function ModernApiErrorRow({ heading, error, live, timestamp, conversationId, signIn, detail }: {
  heading: string;
  error: ParsedApiError;
  /** Still in force (useApiErrorLive): red, with its action. */
  live: boolean;
  timestamp?: number;
  conversationId?: string;
  /** The command that signs the agent in again, for an auth failure. */
  signIn?: string;
  detail?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const send = (text: string) => {
    if (!conversationId) return;
    const store = useInboxStore.getState();
    store.sendMessage(conversationId, text);
    if (text.startsWith("/")) store.markBlockedReviveRequested([conversationId]);
  };
  const serverError = !error.isAuth && !error.isConnection && !error.isThrottle && (error.statusCode ?? 0) >= 500;
  const retry = live && !!conversationId && !error.isContext && !error.isAuth && !error.isSafety
    && (error.isConnection || error.isThrottle || error.isFatal || serverError);
  const actions = live ? (
    error.isContext && conversationId ? (
      <>
        <Button type="button" size="sm" variant="primary" onClick={() => send("/compact")} title="Send /compact: replace the conversation so far with a summary and keep going">Compact</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => send("/clear")} title="Send /clear: drop the history and start fresh in this session">Clear</Button>
      </>
    ) : retry ? (
      <Button type="button" size="sm" variant="outline" onClick={() => send("continue")} title="Send continue: the session picks up where it stopped">Retry</Button>
    ) : error.isAuth && signIn ? (
      <Button
        type="button"
        size="sm"
        variant="outline"
        title={`Copy ${signIn}, then run it in the agent's terminal`}
        onClick={() => { copyToClipboard(signIn).then(() => toast.success(`Copied ${signIn}`)).catch(() => toast.error("Couldn't copy")); }}
      >
        Sign in
      </Button>
    ) : null
  ) : null;
  const first = failureLine(error.message);
  const hasMore = !!detail || !!error.requestId || error.message.trim() !== first;
  const toggle = () => setOpen((v) => !v);
  return (
    <div data-cc-row="error" data-cc-row-tone={live ? "error" : undefined} data-cc-api-error={live ? "live" : "resolved"}>
      <div
        data-cc-row-head
        {...(hasMore ? {
          role: "button",
          tabIndex: 0,
          "aria-expanded": open,
          onClick: toggle,
          onKeyDown: (e: React.KeyboardEvent) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(); } },
        } : {})}
      >
        <TriangleAlert data-cc-row-icon aria-hidden className="w-4 h-4 shrink-0" strokeWidth={1.75} />
        <span data-cc-row-verb>{heading}</span>
        {first && <span data-cc-row-text title={error.message}>{first}</span>}
        {!live && <span data-cc-row-tag>resolved</span>}
        {actions && <span data-cc-row-actions onClick={stop} onKeyDown={stop}>{actions}</span>}
        <span data-cc-row-meta>
          {error.statusCode && !error.isConnection ? <span className="font-mono">{error.statusCode} · </span> : null}
          {timestamp != null && <span title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>}
        </span>
      </div>
      {open && hasMore && (
        <div data-cc-row-detail className="px-3.5 py-2.5 space-y-1.5 text-ui leading-5 text-sol-text-muted">
          {error.message.trim() !== first && <p className="whitespace-pre-wrap break-words text-sol-text">{error.message}</p>}
          {error.requestId && <p className="font-mono text-meta text-sol-text-dim">request_id {error.requestId}</p>}
          {detail}
        </div>
      )}
    </div>
  );
}
