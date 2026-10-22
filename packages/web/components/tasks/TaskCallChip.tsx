"use client";

// The call a task was pulled from (tasks.from_call), as a chip that opens the
// call's page: where the recap, the call's other tasks and its chat are. The
// short id comes from the call list, which a page showing chips keeps live
// with one CallListFeeder; a call outside that list reads "call".

import Link from "next/link";
import { Phone } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useCallList } from "../../hooks/useSyncCalls";

/** Keeps the call list live, so call chips and Call group headers name their
 *  call even on a cold cache. Mount it once per page, not per chip. */
export function CallListFeeder() {
  useCallList(200);
  return null;
}

/** `head` matches the chips in a task page's header; `row` the list row's. */
export function TaskCallChip({ callId, size = "row", className = "" }: { callId: string; size?: "row" | "head"; className?: string }) {
  const shortId = useInboxStore((s: any) => (s.callList?.[callId]?.short_id as string | undefined) ?? null);
  const title = useInboxStore((s: any) => (s.callList?.[callId]?.title as string | undefined) ?? null);
  return (
    <Link
      href={`/calls/${shortId ?? callId}`}
      onClick={(e) => e.stopPropagation()}
      className={`flex items-center gap-1 text-[10px] px-1.5 ${size === "head" ? "py-0.5" : "py-0"} rounded bg-sol-magenta/10 text-sol-magenta border border-sol-magenta/20 hover:bg-sol-magenta/20 transition-colors flex-shrink-0 font-mono ${className}`}
      title={title ? `From the call "${title}"` : "From a call"}
    >
      <Phone className="w-3 h-3" />
      {shortId ?? "call"}
    </Link>
  );
}
