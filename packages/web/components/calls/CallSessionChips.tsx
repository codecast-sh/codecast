"use client";

// On a call's page: the sessions this call reached (fed live or sent an
// excerpt), the way from the call to its agents. The newest few ride the
// header as chips; the full list, with every excerpt each was sent, lives in
// a menu so a call that reached many sessions keeps a one-line header.

import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { callExcerptHref, callLinkHow } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { SessionFace } from "../identity";
import { fmtClock } from "../triggerCadence";
import { FeedChip } from "./FeedChip";
import { excerptLabel } from "./SessionCallPill";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

const SHOWN = 3;

const openSession = (id: string) => useInboxStore.getState().openSidePanel(id);

export function CallSessionChips({ callId, sessions }: { callId: string; sessions: any[] }) {
  const router = useRouter();
  if (sessions.length === 0) return null;
  const shown = sessions.slice(0, SHOWN);
  const hidden = sessions.length - shown.length;
  const anyExcerpts = sessions.some((s) => s.excerpts.length > 0);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      {shown.map((s) => (
        <FeedChip
          key={s.conversation_id}
          route={{ kind: "session", target: s.conversation_id, mode: "live" }}
          fallback={s.name}
          removable={false}
          onOpen={() => openSession(s.conversation_id)}
          title={`${s.title} · ${callLinkHow(s)}`}
        />
      ))}
      {(hidden > 0 || anyExcerpts) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-0.5 rounded-full bg-sol-bg-highlight px-2 py-0.5 font-mono text-[10.5px] leading-4 text-sol-text-muted hover:text-sol-text"
              title={`Every session this call reached (${sessions.length})`}
            >
              {hidden > 0 ? `+${hidden}` : "excerpts"}
              <ChevronDown className="h-2.5 w-2.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-[60vh] max-w-[340px] overflow-y-auto">
            <DropdownMenuLabel className="text-[11px] font-normal text-sol-text-dim">
              This call reached {sessions.length === 1 ? "one session" : `${sessions.length} sessions`}
            </DropdownMenuLabel>
            {sessions.map((s, i) => (
              <div key={s.conversation_id}>
                {i > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem onSelect={() => openSession(s.conversation_id)} className="items-start gap-2">
                  <SessionFace
                    row={{ _id: s.conversation_id, title: s.title, character_avatar: s.character_avatar, character_name: s.character_name }}
                    size={16}
                    className="mt-0.5 shrink-0"
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[12.5px] text-sol-text">{s.name}</span>
                    <span className="truncate text-[11px] text-sol-text-dim">
                      {s.title} · {callLinkHow(s)}
                    </span>
                  </span>
                </DropdownMenuItem>
                {/* An excerpt selects the turns it carried, here on this page. */}
                {[...s.excerpts].reverse().map((e: any) => (
                  <DropdownMenuItem
                    key={`${e.from_seq}-${e.to_seq}-${e.at}`}
                    onSelect={() => router.replace(callExcerptHref(callId, e))}
                    className="pl-[32px] text-[11.5px] text-sol-text-muted"
                  >
                    {excerptLabel(e)}
                    <span className="ml-auto text-sol-text-dim">sent {fmtClock(e.at)}</span>
                  </DropdownMenuItem>
                ))}
              </div>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </span>
  );
}
