"use client";

// The calls page: every transcribed huddle as a first-class object — live
// calls streaming at the top, history below, each with its exact
// speaker-attributed transcript and the auto-generated summary/action items.
// Attribution is structural (one audio track = one speaker), so "who said
// what" is never a diarization guess. The same objects are available to
// agents via `cast calls` / `cast call <id>`.

import { useTeamFeature } from "../../lib/teamFeatures";
import { TeamFeatureOff } from "../../components/TeamFeatureOff";
import { useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { joinCall } from "../../lib/calls/callManager";
import { useInboxStore } from "../../store/inboxStore";
import {
  Phone,
  PhoneCall,
  Radio,
  ListChecks,
  AlignLeft,
  Users,
} from "lucide-react";

function fmtWhen(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay
    ? time
    : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function fmtDuration(startedAt: number, endedAt: number | null): string {
  if (!endedAt) return "live";
  const min = Math.max(1, Math.round((endedAt - startedAt) / 60_000));
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`;
}

// Stable per-speaker accent so a transcript reads as a conversation.
const SPEAKER_COLORS = [
  "text-sol-cyan",
  "text-sol-green",
  "text-sol-yellow",
  "text-sol-violet",
  "text-sol-orange",
  "text-sol-magenta",
];
function speakerColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return SPEAKER_COLORS[h % SPEAKER_COLORS.length];
}

function firstName(name: string): string {
  return name.split("@")[0].split(" ")[0];
}

function CallListRow({ call, selected }: { call: any; selected: boolean }) {
  const live = call.status === "live";
  const who =
    (call.participants || []).map((p: any) => firstName(p.name)).join(", ") ||
    "no one spoke yet";
  return (
    <Link
      href={`/calls/${call._id}`}
      className={`block border-b border-sol-border/15 px-4 py-3 transition-colors hover:bg-sol-bg-alt/40 ${
        selected ? "bg-sol-bg-alt/60" : ""
      }`}
    >
      <div className="flex items-center gap-2">
        {live ? (
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sol-green opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-sol-green" />
          </span>
        ) : (
          <Phone className="h-3 w-3 shrink-0 text-sol-text-dim" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm text-sol-text">
          {call.title || "Untitled huddle"}
        </span>
        <span className="shrink-0 text-[11px] text-sol-text-dim">
          {fmtDuration(call.started_at, call.ended_at)}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-4">
        <span className="text-[11px] text-sol-text-dim">{fmtWhen(call.started_at)}</span>
        <span className="min-w-0 truncate text-[11px] text-sol-text-muted">{who}</span>
      </div>
    </Link>
  );
}

function CallDetail({ id }: { id: string }) {
  // Plain useQuery: a live call's transcript streams into this subscription
  // in real time — segments appear as people speak.
  const call = useQuery(api.transcripts.webGetCall, { transcript_id: id as any });
  const myCall = useInboxStore((s) => s.call);
  if (call === undefined) {
    return <div className="p-8 text-sm text-sol-text-dim">Loading…</div>;
  }
  if (call === null) {
    return <div className="p-8 text-sm text-sol-text-dim">Call not found (or not yours to see).</div>;
  }
  const live = call.status === "live";
  const inThisRoom = myCall.roomKey === call.room_key && myCall.phase === "connected";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-sol-border/20 px-6 py-4">
        <div className="flex items-center gap-3">
          <h1 className="min-w-0 flex-1 truncate text-lg text-sol-text">
            {call.title || "Untitled huddle"}
          </h1>
          {live && !inThisRoom && (
            <button
              onClick={() => void joinCall(call.room_key)}
              className="flex shrink-0 items-center gap-1.5 rounded bg-sol-green/15 px-3 py-1.5 text-xs font-medium text-sol-green transition-colors hover:bg-sol-green/25"
            >
              <PhoneCall className="h-3.5 w-3.5" /> Join
            </button>
          )}
          {live && (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-sol-green">
              <Radio className="h-3.5 w-3.5" /> LIVE
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-sol-text-dim">
          <span>{fmtWhen(call.started_at)}</span>
          <span>{fmtDuration(call.started_at, call.ended_at)}</span>
          {(call.participants || []).length > 0 && (
            <span className="flex items-center gap-1">
              <Users className="h-3 w-3" />
              {(call.participants || []).map((p: any, i: number) => (
                <span key={p.id} className={speakerColor(p.id)}>
                  {firstName(p.name)}
                  {i < call.participants.length - 1 ? "," : ""}
                </span>
              ))}
            </span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {call.summary && (
          <div className="mb-5 rounded-md border border-sol-border/25 bg-sol-bg-alt/40 px-4 py-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-sol-text-dim">
              <AlignLeft className="h-3 w-3" /> Summary
            </div>
            <p className="text-[13px] leading-relaxed text-sol-text">{call.summary}</p>
            {(call.action_items || []).length > 0 && (
              <div className="mt-3">
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-sol-text-dim">
                  <ListChecks className="h-3 w-3" /> Action items
                </div>
                <ul className="space-y-1">
                  {call.action_items.map((a: string, i: number) => (
                    <li key={i} className="flex gap-2 text-[13px] text-sol-text">
                      <span className="text-sol-cyan">→</span>
                      <span>{a}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {!call.summary && !live && (
          <div className="mb-5 text-[12px] text-sol-text-dim">
            {call.summary_status === "skipped"
              ? "Too short to summarize."
              : call.summary_status === "failed"
                ? "Summary generation failed."
                : "Summary pending…"}
          </div>
        )}

        {(call.segments || []).length === 0 ? (
          <div className="text-sm text-sol-text-dim">
            {live ? "Listening — the transcript appears as people speak." : "Nothing was transcribed."}
          </div>
        ) : (
          <div className="space-y-2 pb-8">
            {call.segments.map((s: any, i: number) => {
              const prev = call.segments[i - 1];
              const newSpeaker = !prev || prev.speaker_id !== s.speaker_id;
              return (
                <div key={s.seq}>
                  {newSpeaker && (
                    <div className={`mt-3 text-[11px] font-medium ${speakerColor(s.speaker_id)}`}>
                      {s.speaker_name}
                      <span className="ml-2 font-normal text-sol-text-dim">
                        {Math.floor(s.t0 / 60000)}:{String(Math.floor((s.t0 % 60000) / 1000)).padStart(2, "0")}
                      </span>
                    </div>
                  )}
                  <p className="text-[13px] leading-relaxed text-sol-text">{s.text}</p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function CallsPage() {
  const params = useParams() as { id?: string };
  const selectedId = params?.id ?? null;
  const callsOn = useTeamFeature("calls");
  const calls = useQueryNoThrow(api.transcripts.webListCalls, callsOn ? { limit: 100 } : "skip").data as
    | any[]
    | undefined;
  const { liveCalls, pastCalls } = useMemo(() => {
    const rows = calls ?? [];
    return {
      liveCalls: rows.filter((r) => r.status === "live"),
      pastCalls: rows.filter((r) => r.status !== "live"),
    };
  }, [calls]);

  if (!callsOn) {
    return (
      <AuthGuard>
        <DashboardLayout>
          <TeamFeatureOff feature="calls" />
        </DashboardLayout>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="flex h-full min-h-0">
          <div className="flex w-80 shrink-0 flex-col border-r border-sol-border/20">
            <div className="shrink-0 border-b border-sol-border/20 px-4 py-3">
              <h2 className="text-sm font-medium text-sol-text">Calls</h2>
              <p className="mt-0.5 text-[11px] text-sol-text-dim">
                Transcribed huddles — also via <code className="text-sol-cyan">cast calls</code>
              </p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {calls === undefined ? (
                <div className="p-4 text-[12px] text-sol-text-dim">Loading…</div>
              ) : calls.length === 0 ? (
                <div className="p-4 text-[12px] leading-relaxed text-sol-text-dim">
                  No calls yet. Start a huddle and toggle Transcribe — the call
                  lands here with a live transcript and, when it ends, a summary.
                </div>
              ) : (
                <>
                  {liveCalls.length > 0 && (
                    <div className="bg-sol-bg-alt/30 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-sol-green">
                      Live ({liveCalls.length})
                    </div>
                  )}
                  {liveCalls.map((r) => (
                    <CallListRow key={r._id} call={r} selected={r._id === selectedId} />
                  ))}
                  {pastCalls.length > 0 && (
                    <div className="bg-sol-bg-alt/30 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-sol-text-dim">
                      History
                    </div>
                  )}
                  {pastCalls.map((r) => (
                    <CallListRow key={r._id} call={r} selected={r._id === selectedId} />
                  ))}
                </>
              )}
            </div>
          </div>
          <div className="min-w-0 flex-1">
            {selectedId ? (
              <CallDetail id={selectedId} />
            ) : (
              <div className="flex h-full items-center justify-center">
                <div className="text-center text-sol-text-dim">
                  <Phone className="mx-auto mb-2 h-6 w-6 opacity-40" />
                  <div className="text-sm">Select a call</div>
                </div>
              </div>
            )}
          </div>
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
