import React, { useMemo } from "react";
import Link from "next/link";
import { MessageSquareQuote } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { formatToolName } from "@codecast/shared/render";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { parseMessageRefPayload, truncateEntityLabel, type MessageRef } from "../lib/entityLinks";
import { cleanTitle } from "../lib/conversationProcessor";
import { agentDisplayName } from "../lib/commentThread";
import { stripMarkdown } from "../lib/notificationText";
import { MessageBlock, type SharedMessageData } from "../app/share/message/[token]/SharedMessageView";
import { CardMarkdown, ObjectCardFrame } from "./EntityObjectCard";
import { ACCENT } from "../lib/entityCardAccent";
import { AuthorAvatar } from "./entityDisplay";
import { relativeTime } from "../lib/entityDisplay";
import { clipFade } from "./CollapsibleBody";

// A conversation message shared into chat — by its public share link
// (/share/message/<token>) or in place (/conversation/<id>#msg-<id>). Both
// resolve to the same payload the share page renders, so the card previews the
// message itself, rich, and expands into the share page's message blocks
// without leaving the conversation. The chrome is ObjectCardFrame, the same
// card every other shared object renders as; the pill is the in-prose twin.

type Resolution = {
  ref: MessageRef | null;
  data: SharedMessageData | null | undefined;
  /** In-app route for the message: the share page, or the session at the message. */
  href: string;
};

/**
 * One message reference in, the share-page payload out. A share token reads
 * publicly; an in-place reference reads with the viewer's conversation access,
 * so a teammate who cannot open the session sees "Not available to you." —
 * the same degrade every other card has. Both no-throw: a reference must
 * never crash the surface that mentions it.
 */
function useMessageRef(payload: string): Resolution {
  const ref = parseMessageRefPayload(payload);
  const { data: shared } = useQueryNoThrow(
    api.messages.getSharedMessage,
    ref?.kind === "share" ? { share_token: ref.token } : "skip",
  );
  const { data: inPlace } = useQueryNoThrow(
    api.messages.webGet,
    ref?.kind === "message" ? { id: ref.id } : "skip",
  );
  const data = (ref?.kind === "share" ? shared : inPlace) as SharedMessageData | null | undefined;
  const href =
    ref?.kind === "share"
      ? `/share/message/${ref.token}`
      : ref && data?.conversation?._id
        ? `/conversation/${data.conversation._id}#msg-${ref.id}`
        : "#";
  return { ref, data, href };
}

/** Who wrote the message: the human, or the agent by its product name. */
function roleLabel(message: any, agentType?: string | null): string {
  return message?.role === "user" ? "User" : agentDisplayName(agentType ?? undefined);
}

/** The message's first meaningful line, for the pill and the aria name. */
function messageLead(message: any): string {
  const line = String(message?.content ?? "").split("\n").find((l: string) => l.trim()) ?? "";
  const lead = stripMarkdown(line).trim();
  if (lead) return lead;
  const tool = message?.tool_calls?.[0];
  return tool ? formatToolName(tool.name) : "";
}

/** The collapsed preview: the shared message rendered rich, clipped with a fade. */
function MessageSnippet({ message, compact }: { message: any; compact: boolean }) {
  if (message?.content?.trim()) {
    return (
      <div className="overflow-hidden" style={{ maxHeight: compact ? 72 : 160, ...clipFade(28) }}>
        <CardMarkdown content={message.content} />
      </div>
    );
  }
  const tools: any[] = message?.tool_calls ?? [];
  if (tools.length === 0) return null;
  return (
    <p className="truncate font-mono text-[11px] text-sol-text-muted">
      {tools.map((t) => formatToolName(t.name)).join(" · ")}
    </p>
  );
}

/** The full inline browse: the sharer's note, then every shared message as the share page renders it. */
function MessageDetail({ data, now }: { data: SharedMessageData; now: number }) {
  return (
    <div className="space-y-2.5">
      {data.note && (
        <div className="rounded-md border border-sol-yellow/30 bg-sol-yellow/10 px-2.5 py-1.5">
          <div className="text-[10px] font-medium text-sol-yellow">Note from sharer</div>
          <div className="text-[12px] text-sol-text">{data.note}</div>
        </div>
      )}
      <div className="max-h-[70vh] overflow-y-auto pr-1 text-[12px]">
        {data.contextMessages.map((msg: any) => (
          <MessageBlock key={msg._id} message={msg} isTarget={msg._id === data.message._id} now={now} />
        ))}
      </div>
    </div>
  );
}

/** A shared message alone on its line: the browsable card. */
export function SharedMessageCard({ refId, count }: { refId: string; count: number }) {
  const { ref, data, href } = useMessageRef(refId);
  // The share page takes `now` as a prop (it hydrates server markup); the card
  // is client-only, so one timestamp per resolution is enough.
  const now = useMemo(() => Date.now(), [data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ref) return <span className="font-mono text-[11px] text-sol-text-dim">{refId}</span>;

  const message = data?.message;
  const title = data ? cleanTitle(data.conversation.title || "Conversation") : null;
  const author = roleLabel(message, data?.conversation?.agent_type);
  const count_ = data?.contextMessages?.length ?? 0;
  const sharer = data?.user;

  return (
    <ObjectCardFrame
      accent={ACCENT.session}
      count={count}
      ariaLabel={`Message: ${data ? `${author} in ${title}` : refId}`}
      href={href}
      openLabel={ref.kind === "share" ? "Open shared message" : "Open in session"}
      footerId={ref.kind === "share" ? "shared message" : `msg-${ref.id.slice(0, 7)}`}
      resolved={!!data}
      served={data !== undefined}
      header={{
        icon:
          sharer?.name || sharer?.image ? (
            <AuthorAvatar name={sharer.name ?? undefined} avatar={sharer.image} size={16} />
          ) : (
            <MessageSquareQuote className={`h-3.5 w-3.5 ${ACCENT.session.text}`} />
          ),
        title: data ? title : <span className="font-mono text-sol-text-dim">{refId}</span>,
        meta: data ? (
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-sol-text-muted">
            <span className={`whitespace-nowrap font-medium ${message?.role === "user" ? "text-sol-blue" : "text-sol-orange"}`}>{author}</span>
            {count_ > 1 && (
              <span className="whitespace-nowrap before:mr-1.5 before:content-['·']">{count_} messages</span>
            )}
            {sharer?.name && ref.kind === "share" && (
              <span className="truncate before:mr-1.5 before:content-['·']">shared by {sharer.name}</span>
            )}
          </div>
        ) : undefined,
        timeAgo: relativeTime(message?.timestamp),
      }}
      snippet={<MessageSnippet message={message} compact={count > 1} />}
      detail={data ? <MessageDetail data={data} now={now} /> : null}
    />
  );
}

/** A shared message inside a sentence: the inline pill, titled by the message's lead line. */
export function SharedMessagePill({ refId }: { refId: string }) {
  const { ref, data, href } = useMessageRef(refId);
  if (!ref) return <span>{refId}</span>;
  const message = data?.message;
  const lead = message ? messageLead(message) : "";
  const label = data
    ? truncateEntityLabel(lead || cleanTitle(data.conversation.title || "message"))
    : "message";
  const tooltip = data ? `${roleLabel(message, data.conversation.agent_type)} in ${cleanTitle(data.conversation.title || "Conversation")}` : undefined;
  return (
    <Link
      href={href}
      title={tooltip}
      className="not-prose inline-flex items-center gap-1 rounded border border-sol-blue/20 bg-sol-blue/10 px-2 py-0.5 align-baseline font-mono text-xs leading-[1.4] text-sol-blue no-underline transition-colors hover:bg-sol-blue/20"
    >
      <MessageSquareQuote className="h-3 w-3 flex-shrink-0" />
      <span className="max-w-[280px] truncate">{label}</span>
    </Link>
  );
}
