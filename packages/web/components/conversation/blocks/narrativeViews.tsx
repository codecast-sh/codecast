// The narrative views of a conversation: the story (a beat per turn, with the
// prompt that started it) and the summary, each read from a cached level and
// regenerated when it goes stale.

import { memo, useCallback, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api as _typedApi } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { AvatarImg } from "../../../lib/avatarCache";
import { formatRelativeTime } from "../../../lib/conversationFormat";
import { stripSystemTags } from "../classify";
import { MessageMarkdown } from "../markdown";
import type { StoryBeat } from "../types";

const api = _typedApi as any;

function StorySpinner() {
  return (
    <svg className="w-3.5 h-3.5 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );
}

// Subscribe to a cached narrative level and auto-(re)generate when missing or
// stale — once per (conversation, message_count) so a still-stale-mid-run query
// doesn't re-fire. Refresh button covers later regenerations.
function useNarrativeLevel(
  conversationId: Id<"conversations"> | undefined,
  level: "story" | "summary",
) {
  const query = level === "story" ? api.storyMode.getStory : api.storyMode.getSummary;
  const genAction = level === "story" ? api.storyMode.generateStory : api.storyMode.generateSummary;
  const data = useQueryNoThrow(query, conversationId ? { conversation_id: conversationId } : "skip").data;
  const generate = useAction(genAction);
  const [generating, setGenerating] = useState(false);
  const firedRef = useRef<string | null>(null);
  const run = useCallback(() => {
    if (!conversationId) return;
    setGenerating(true);
    generate({ conversation_id: conversationId }).catch(() => {}).finally(() => setGenerating(false));
  }, [conversationId, generate]);
  useWatchEffect(() => {
    if (!conversationId || !data || !data.stale) return;
    const key = `${conversationId}:${data.message_count}`;
    if (firedRef.current === key) return;
    firedRef.current = key;
    run();
  }, [conversationId, data?.stale, data?.message_count, run]);
  const items = (data?.items ?? []) as StoryBeat[];
  return { items, data, generating, run, loading: data === undefined };
}

function NarrativeSkeleton({ rows }: { rows: number }) {
  return (
    <div className="relative pl-8 animate-pulse">
      <div className="absolute left-[9px] top-2 bottom-2 w-px bg-sol-border/40" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="relative pb-8">
          <div className="absolute -left-[26px] top-1 w-[18px] h-[18px] rounded-full bg-sol-bg ring-2 ring-sol-border/50" />
          <div className="h-3.5 w-40 rounded bg-sol-border/50 mb-3" />
          <div className="space-y-1.5">
            <div className="h-2.5 rounded bg-sol-border/40 w-full" />
            <div className="h-2.5 rounded bg-sol-border/40 w-5/6" />
            <div className="h-2.5 rounded bg-sol-border/40 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

const BeatRow = memo(function BeatRow({ beat, userName, avatarUrl, showPrompt, accent, onJump }: {
  beat: StoryBeat;
  userName?: string;
  avatarUrl?: string | null;
  showPrompt: boolean;
  accent: "blue" | "violet";
  onJump?: (messageId: string, timestamp: number) => void;
}) {
  const prompt = stripSystemTags(beat.anchor_prompt || "").trim();
  const dotColor = accent === "violet" ? "bg-sol-violet" : "bg-sol-cyan";
  return (
    <div className="relative pl-8 pb-8 last:pb-2 group/beat">
      <button
        onClick={onJump ? () => onJump(beat.anchor_message_id, beat.anchor_timestamp) : undefined}
        className={`absolute left-0 top-0.5 w-[18px] h-[18px] rounded-full flex items-center justify-center bg-sol-bg ring-2 ring-sol-border transition-all group-hover/beat:ring-sol-cyan hover:!ring-sol-cyan hover:scale-110`}
        title="Jump to this point in the conversation"
      >
        <span className={`block w-2 h-2 rounded-full ${dotColor}`} />
      </button>
      {beat.heading && (
        <h3 className="text-[15px] font-semibold text-sol-text leading-snug mb-2 mt-px tracking-tight">{beat.heading}</h3>
      )}
      {showPrompt && prompt && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border-l-2 border-sol-blue/70 bg-sol-blue/[0.07] pl-3 pr-3 py-2">
          <AvatarImg
            src={avatarUrl}
            alt=""
            className="w-4 h-4 rounded-full shrink-0 mt-px"
            fallback={<span className="text-mark font-bold uppercase tracking-wider text-sol-blue shrink-0 mt-0.5">{(userName || "You").slice(0, 1)}</span>}
          />
          <span className="text-[12.5px] text-sol-text-secondary whitespace-pre-wrap break-words leading-snug">{prompt}</span>
        </div>
      )}
      <div className="prose prose-invert prose-sm max-w-none text-sol-text/95 leading-relaxed">
        <MessageMarkdown content={beat.body} />
      </div>
    </div>
  );
});

function NarrativeFooter({ data, generating, run, unit }: { data: any; generating: boolean; run: () => void; unit: string }) {
  "use no memo"; // formatRelativeTime() reads the clock as this renders; compiled, the time shown would stop moving.
  return (
    <div className="mt-2 pt-3 border-t border-sol-border/40 flex items-center gap-3 text-meta text-sol-text-dim">
      <span>
        {data?.message_count ? `Through ${data.message_count} messages` : unit}
        {data?.generated_at ? ` · ${formatRelativeTime(data.generated_at)}` : ""}
      </span>
      {generating ? (
        <span className="flex items-center gap-1.5"><StorySpinner /> updating…</span>
      ) : data?.stale ? (
        <button onClick={run} className="text-sol-cyan/80 hover:text-sol-cyan transition-colors font-medium">Update</button>
      ) : null}
    </div>
  );
}

export function StoryTimelineView({ conversationId, userName, avatarUrl, onJump }: { conversationId?: Id<"conversations">; userName?: string; avatarUrl?: string | null; onJump?: (messageId: string, timestamp: number) => void }) {
  const { items, data, generating, run, loading } = useNarrativeLevel(conversationId, "story");
  if (loading || (items.length === 0 && (generating || data?.stale)))
    return <div className="py-8"><div className="mb-5 flex items-center gap-2 text-[12px] text-sol-text-dim"><StorySpinner /> Composing the story of this session…</div><NarrativeSkeleton rows={4} /></div>;
  if (items.length === 0) return <div className="py-12 text-center text-sm text-sol-text-dim">Nothing to retell yet.</div>;
  return (
    <div className="py-7">
      <div className="relative">
        <div className="absolute left-[9px] top-2 bottom-6 w-px bg-gradient-to-b from-sol-border via-[color-mix(in_srgb,var(--sol-border)_60%,transparent)] to-transparent" />
        {items.map((b) => (
          <BeatRow key={b.anchor_message_id} beat={b} userName={userName} avatarUrl={avatarUrl} showPrompt accent="blue" onJump={onJump} />
        ))}
      </div>
      <NarrativeFooter data={data} generating={generating} run={run} unit="Story" />
    </div>
  );
}

export function ThreadSummaryView({ conversationId, userName, avatarUrl, onJump }: { conversationId?: Id<"conversations">; userName?: string; avatarUrl?: string | null; onJump?: (messageId: string, timestamp: number) => void }) {
  const { items, data, generating, run, loading } = useNarrativeLevel(conversationId, "summary");
  if (loading || (items.length === 0 && (generating || data?.stale)))
    return <div className="py-8"><div className="mb-5 flex items-center gap-2 text-[12px] text-sol-text-dim"><StorySpinner /> Distilling the session…</div><NarrativeSkeleton rows={3} /></div>;
  if (items.length === 0) return <div className="py-12 text-center text-sm text-sol-text-dim">Nothing to summarize yet.</div>;
  return (
    <div className="py-7">
      <div className="relative">
        <div className="absolute left-[9px] top-2 bottom-6 w-px bg-gradient-to-b from-sol-violet/50 via-[color-mix(in_srgb,var(--sol-border)_60%,transparent)] to-transparent" />
        {items.map((b) => (
          <BeatRow key={b.anchor_message_id} beat={b} userName={userName} avatarUrl={avatarUrl} showPrompt accent="violet" onJump={onJump} />
        ))}
      </div>
      <NarrativeFooter data={data} generating={generating} run={run} unit="Summary" />
    </div>
  );
}
