"use client";

// In a conversation header: the call this session's words came from, when a
// huddle fed it live or someone sent it the transcript or a range of turns.
// The way back from an agent to its call; the call page lists the agents.

import Link from "next/link";
import { Phone } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { callLinkHow, callLinkHref } from "@codecast/shared/contracts";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { isConvexId } from "../../lib/entityLinks";

export function SessionCallPill({ conversationId }: { conversationId: string }) {
  const calls = useQueryNoThrow(
    api.transcripts.webCallsForConversation,
    isConvexId(conversationId) ? { conversation_id: conversationId as any } : "skip",
  ).data;
  if (!calls || calls.length === 0) return null;
  const [latest, ...rest] = calls;
  const name = (c: any) => c.title || "Untitled huddle";
  return (
    <Link
      href={callLinkHref(String(latest._id), latest)}
      className="inline-flex min-w-0 max-w-[180px] flex-shrink items-center gap-1 rounded-full bg-sol-bg-highlight px-2 py-0.5 text-[10.5px] leading-4 text-sol-text-muted hover:text-sol-text"
      title={calls.map((c: any) => `${name(c)} · ${callLinkHow(c)}`).join("\n")}
    >
      <Phone className={`h-2.5 w-2.5 shrink-0 ${latest.status === "live" ? "text-sol-green" : ""}`} />
      <span className="truncate">{name(latest)}</span>
      {rest.length > 0 && <span className="shrink-0 text-sol-text-dim">+{rest.length}</span>}
    </Link>
  );
}
