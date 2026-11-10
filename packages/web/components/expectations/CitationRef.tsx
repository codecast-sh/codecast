"use client";
// Where an expectation came from, as references a reader can open
// (the-line-model.md LM5; line-map.md LX7): tasks, calls, decisions and
// sessions as live titled pills, a chat line as a link to its message, a
// commit by its repository and short sha, a person by name. Never a raw id.
import Link from "next/link";
import type { ExpectationCitation } from "@codecast/shared/contracts/expectations";
import { EntityIdPill } from "../EntityIdPill";
import { chatHref } from "../../lib/chatHref";
import { resolveAssigneeInfo } from "../../lib/liveEntities";
import { shortDay } from "../../lib/line/runReport";
import { useInboxStore } from "../../store/inboxStore";
import { cn } from "../../lib/utils";

const PILL_KINDS = new Set(["call", "call_grade", "task", "decision", "session", "signal", "desk", "doc"]);

/** A citation's day in a reader's words: "Sep 30" for an ISO day, else as written. */
function citationWhen(when: string | undefined): string | null {
  if (!when) return null;
  // A bare ISO day is that calendar day wherever the reader is: read as UTC midnight it would show the day before west of Greenwich.
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(when);
  if (day) return shortDay(new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime());
  const at = Date.parse(when);
  return Number.isFinite(at) && /^\d{4}-\d{2}-\d{2}/.test(when) ? shortDay(at) : when;
}

/** The person a "person" citation names (its ref is their user id), by name from the live roster. */
function usePersonName(userId: string | null): string | null {
  return useInboxStore((s) => (userId ? resolveAssigneeInfo(userId, null, s.teamMembers, s.currentUser as any)?.name ?? null : null));
}

/** Where the citation lives, as a reference a reader can open. */
export function CitationRef({ c }: { c: ExpectationCitation }) {
  const ref = c.ref.trim();
  const title = c.quote ? `"${c.quote}"${c.when ? `, ${c.when}` : ""}` : c.when;
  // "#team/<message id>": the channel by name, the message by id.
  const chat = c.kind === "chat" ? /^#?([^/\s]+)\/(\S+)$/.exec(ref) : null;
  const channelId = useInboxStore((s) => (chat ? (Object.values(s.chatChannels ?? {}) as Array<{ _id: string; name?: string }>).find((ch) => ch.name === chat[1])?._id ?? null : null));
  // "app@6422863a35": a commit whose repository the reference names without its owner.
  const commit = c.kind === "commit" ? /^([^@\s]+)@([0-9a-f]{7,40})$/i.exec(ref) : null;
  const repository = useInboxStore((s) => {
    if (!commit || commit[1].includes("/")) return commit?.[1] ?? null;
    const rows = [...Object.values(s.pullRequests ?? {}), ...Object.values(s.commits ?? {})] as Array<{ repository?: string }>;
    return rows.find((r) => r.repository?.toLowerCase().endsWith(`/${commit[1].toLowerCase()}`))?.repository ?? null;
  });
  const person = usePersonName(c.kind === "person" ? ref : null);
  if (c.kind === "person") return <span className="text-sol-text-muted" title="Typed where the expectations are read" data-citation="person">{person ?? "a teammate"}</span>;
  if (chat) {
    const href = chatHref(channelId ?? undefined, chat[2]);
    const body = <>#{chat[1]} thread</>;
    return href ? <Link href={href} className="hover:text-sol-blue hover:underline" title={title} data-citation="chat">{body}</Link> : <span title={title} data-citation="chat">{body}</span>;
  }
  if (commit) {
    if (repository?.includes("/")) return <span title={title} data-citation="commit"><EntityIdPill id={`${repository}@${commit[2]}`} type="commit" compact certain /></span>;
    return <span className="font-mono" title={title ?? ref} data-citation="commit">{commit[1]}@{commit[2].slice(0, 7)}</span>;
  }
  if (PILL_KINDS.has(c.kind) && !/^[a-z0-9]{32}$/i.test(ref)) return <span title={title} data-citation={c.kind}><EntityIdPill shortId={ref} compact /></span>;
  // A path or anything else, kept short: a long reference reads by its tail.
  const words = ref.length > 40 ? `…${ref.slice(-36)}` : ref;
  return <span title={title ?? ref} data-citation={c.kind}>{words}</span>;
}

/** One source in full: the words, then who said them, where and when. `who`
 *  comes from the record (the chat line's author, the decision's answerer,
 *  the call's speaker) when the server could name them. */
export function CitationLine({ c, className, quote = true, who }: { c: ExpectationCitation; className?: string; quote?: boolean; who?: string }) {
  const when = citationWhen(c.when);
  const speaker = c.kind === "person" ? null : who;
  return (
    <div className={cn("text-[11.5px] leading-snug text-sol-text-dim", className)} data-citation-line={c.kind}>
      {quote && c.quote && <q className="block italic text-sol-text-muted line-clamp-3" data-citation-quote>{c.quote}</q>}
      <span className="mt-0.5 inline-flex flex-wrap items-baseline gap-x-1.5" data-citation-meta>
        {speaker && <span className="text-sol-text-muted" data-citation-who>{speaker}</span>}
        {speaker && <span aria-hidden>·</span>}
        <CitationRef c={c} />
        {when && <span className="tabular-nums" data-citation-when>{when}</span>}
      </span>
    </div>
  );
}
