"use client";

// In a conversation header: the calls this session's words came from, when a
// huddle fed it live or someone sent it the transcript or a range of turns.
// The way back from an agent to its calls; the call page lists the agents.
// One call reached once is a plain link; anything more (several calls, or
// several excerpts of one) opens a menu with every call and every excerpt.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Phone } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { callExcerptHref, callLinkHow, callLinkHref } from "@codecast/shared/contracts";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { isConvexId } from "../../lib/entityLinks";
import { fmtClock } from "../triggerCadence";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

const PILL =
  "inline-flex min-w-0 max-w-[180px] flex-shrink items-center gap-1 rounded-full bg-sol-bg-highlight px-2 py-0.5 text-[10.5px] leading-4 text-sol-text-muted hover:text-sol-text";

const callName = (c: any) => c.title || "Untitled huddle";

// Seqs are the transcript's own counter, never shown, so an excerpt reads by
// its size and when it was sent.
export function excerptLabel(e: { from_seq: number; to_seq: number }): string {
  const n = e.to_seq - e.from_seq + 1;
  return `Excerpt · ${n} line${n === 1 ? "" : "s"}`;
}

export function SessionCallPill({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const calls = useQueryNoThrow(
    api.transcripts.webCallsForConversation,
    isConvexId(conversationId) ? { conversation_id: conversationId as any } : "skip",
  ).data;
  if (!calls || calls.length === 0) return null;
  const [latest] = calls;
  const face = (
    <>
      <Phone className={`h-2.5 w-2.5 shrink-0 ${calls.some((c: any) => c.status === "live") ? "text-sol-green" : ""}`} />
      <span className="truncate">{callName(latest)}</span>
      {calls.length > 1 && <span className="shrink-0 text-sol-text-dim">+{calls.length - 1}</span>}
    </>
  );

  if (calls.length === 1 && latest.excerpts.length <= 1) {
    return (
      <Link href={callLinkHref(String(latest._id), latest)} className={PILL} title={`${callName(latest)} · ${callLinkHow(latest)}`}>
        {face}
      </Link>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={PILL} title={`From ${calls.length === 1 ? "a call" : `${calls.length} calls`}`}>
          {face}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-[320px]">
        <DropdownMenuLabel className="text-[11px] font-normal text-sol-text-dim">
          This session heard {calls.length === 1 ? "one call" : `${calls.length} calls`}
        </DropdownMenuLabel>
        {calls.map((c: any, i: number) => (
          <div key={String(c._id)}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={() => router.push(callExcerptHref(String(c._id)))} className="flex-col items-start gap-0">
              <span className="flex w-full items-center gap-1.5 text-[12.5px] text-sol-text">
                <Phone className={`h-3 w-3 shrink-0 ${c.status === "live" ? "text-sol-green" : "text-sol-text-dim"}`} />
                <span className="truncate">{callName(c)}</span>
              </span>
              <span className="pl-[18px] text-[11px] text-sol-text-dim">
                {fmtClock(c.started_at)} · {callLinkHow(c)}
              </span>
            </DropdownMenuItem>
            {[...c.excerpts].reverse().map((e: any) => (
              <DropdownMenuItem
                key={`${e.from_seq}-${e.to_seq}-${e.at}`}
                onSelect={() => router.push(callExcerptHref(String(c._id), e))}
                className="pl-[26px] text-[11.5px] text-sol-text-muted"
              >
                {excerptLabel(e)}
                <span className="ml-auto text-sol-text-dim">sent {fmtClock(e.at)}</span>
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
