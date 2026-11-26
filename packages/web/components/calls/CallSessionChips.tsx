"use client";

// On a call's page: the sessions this call reached (fed live or sent an
// excerpt), the way from the call to its agents. The newest few ride the
// header as chips; the full list, with every excerpt each was sent, lives in
// a menu so a call that reached many sessions keeps a one-line header.
//
// A session the room's thread already shows (an agent the call feeds live,
// with its chip in the thread's head) is not shown again as a chip here: one
// session, one chip on the page. The menu still lists every session, with
// what each was sent. The chips that do show are led by "sent to", so a
// session never reads as one of the people in the call beside it.
//
// Beside them, each teammate in the call who has a session open right now
// gets a chip led by their name ("Samvit in Company wiki planning"), one click
// to that conversation, so the person on the call reaches what they are
// discussing without searching for it. It reads the roster's
// viewing_conversation_id (the server only reports sessions the viewer may
// open) and follows it live; the viewer, offline teammates and a session the
// call already shows get no chip.

import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { callExcerptHref, callLinkHow } from "@codecast/shared/contracts";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { teamMembersOf } from "../../lib/activeTeam";
import { teammateWhereabouts } from "../presence/memberPresence";
import { SessionFace } from "../identity";
import { fmtClock } from "../triggerCadence";
import { FeedChip } from "./FeedChip";
import { excerptLabel } from "../../lib/calls/excerptLabel";
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

type TeammateSession = { id: string; name: string; conversationId: string; title: string | undefined };

/** The call's teammates who have a session open now, from the roster. */
function teammateSessionsOf(s: any, participantIds: ReadonlySet<string>): TeammateSession[] {
  if (participantIds.size === 0) return [];
  const viewerId = s.currentUser?._id ? String(s.currentUser._id) : null;
  return teammateWhereabouts(teamMembersOf(s), viewerId, "", s.sessions)
    .filter((w) => w.conversationId && participantIds.has(w.id))
    .map((w) => ({
      id: w.id,
      name: w.name,
      conversationId: w.conversationId!,
      title: w.title,
    }));
}

const firstName = (name: string) => name.split(" ")[0] || name;

export function CallSessionChips({
  callId,
  sessions,
  inThread,
  participants,
}: {
  callId: string;
  sessions: any[];
  /** Sessions the thread's head already shows as chips. */
  inThread?: ReadonlySet<string>;
  /** The people in the call (identity is the user id). */
  participants?: { id: string; name?: string }[];
}) {
  const router = useRouter();
  const participantIds = new Set((participants ?? []).map((p) => String(p.id)));
  // Re-render only when what a chip shows changes, not on every roster tick.
  const st = useTrackedStore([
    (s) =>
      teammateSessionsOf(s, participantIds)
        .map((t) => `${t.id}:${t.conversationId}:${t.title ?? ""}:${t.name}`)
        .join("|"),
  ]);
  const reached = new Set(sessions.map((s) => String(s.conversation_id)));
  const teammates = teammateSessionsOf(st, participantIds).filter(
    (t) => !reached.has(t.conversationId) && !inThread?.has(t.conversationId),
  );
  if (sessions.length === 0 && teammates.length === 0) return null;
  const own = sessions.filter((s) => !inThread?.has(String(s.conversation_id)));
  const shown = own.slice(0, SHOWN);
  const hidden = own.length - shown.length;
  const anyExcerpts = sessions.some((s) => s.excerpts.length > 0);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      {teammates.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => openSession(t.conversationId)}
          className="flex max-w-[260px] items-center gap-1 rounded-full bg-sol-bg-highlight px-2 py-0.5 font-mono text-meta leading-4 text-sol-text-muted hover:text-sol-text"
          title={`${t.name} is working in ${t.title ?? "a session"}`}
        >
          <span className="shrink-0 text-sol-text">{firstName(t.name)}</span>
          <span className="shrink-0 text-sol-text-dim">in</span>
          <span className="truncate">{t.title ?? "their session"}</span>
        </button>
      ))}
      {shown.length > 0 && <span className="text-meta text-sol-text-dim">sent to</span>}
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
              className="flex items-center gap-0.5 rounded-full bg-sol-bg-highlight px-2 py-0.5 font-mono text-meta leading-4 text-sol-text-muted hover:text-sol-text"
              title={`Every session this call reached (${sessions.length})`}
            >
              {hidden > 0 ? `+${hidden}` : shown.length > 0 ? "excerpts" : "sent to"}
              <ChevronDown className="h-2.5 w-2.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-[60vh] max-w-[340px] overflow-y-auto">
            <DropdownMenuLabel className="text-meta font-normal text-sol-text-dim">
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
                    <span className="truncate text-meta text-sol-text-dim">
                      {s.title} · {callLinkHow(s)}
                    </span>
                  </span>
                </DropdownMenuItem>
                {/* An excerpt selects the turns it carried, here on this page. */}
                {[...s.excerpts].reverse().map((e: any) => (
                  <DropdownMenuItem
                    key={`${e.from_seq}-${e.to_seq}-${e.at}`}
                    onSelect={() => router.replace(callExcerptHref(callId, e))}
                    className="pl-[32px] text-meta text-sol-text-muted"
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
