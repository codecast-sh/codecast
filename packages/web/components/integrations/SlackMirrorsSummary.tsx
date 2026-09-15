"use client";

// Under the team's Slack card: which chat channels mirror which Slack channels.
// Reads the store (chat.listChannels feeds chatSlackLinks), so it is honest
// about the active team and paints from cache. The per-channel controls live in
// the channel's own dialog; this is the team-wide glance and the way there.
import Link from "next/link";
import { Hash, Lock } from "lucide-react";
import { DIRECTION_ARROW } from "@codecast/convex/convex/lib/slackMirror";
import { useTrackedStore } from "../../store/inboxStore";
import { slackLinksSig } from "../../hooks/useChatSync";
import type { ChatSlackLinkRow } from "../../store/chatSlice";

export function SlackMirrorsSummary() {
  const s = useTrackedStore([
    (st) => slackLinksSig(st.chatSlackLinks as any),
    (st) => Object.keys(st.chatChannels ?? {}).length,
  ]);
  const links = Object.values(s.chatSlackLinks ?? {}) as ChatSlackLinkRow[];
  const rows = links
    .map((l) => ({ link: l, channel: s.chatChannels[l.chat_channel_id] }))
    .filter((r) => !!r.channel)
    .sort((a, b) => (a.channel!.name ?? "").localeCompare(b.channel!.name ?? ""));

  return (
    <div className="mt-3 border-t border-sol-border/40 pt-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.09em] text-sol-text-dim">Mirrored channels</div>
      {rows.length === 0 ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-sol-text-dim">
          None yet. Open a channel in Chat and choose <span className="text-sol-text-muted">Mirror with Slack</span> from
          its menu or the Slack pill in its header.
        </p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1">
          {rows.map(({ link, channel }) => {
            return (
              <li key={link._id} className="flex items-center gap-2 text-[11.5px]">
                <Link href={`/chat/${link.chat_channel_id}`} className="inline-flex items-center gap-0.5 text-sol-text hover:underline">
                  <Hash className="w-3 h-3 text-sol-text-dim" />
                  {channel!.name}
                </Link>
                <span className="text-sol-text-dim">{DIRECTION_ARROW[link.direction]}</span>
                <span className="inline-flex items-center gap-0.5 text-sol-text-muted">
                  {link.slack_channel_private ? <Lock className="w-3 h-3" /> : <Hash className="w-3 h-3" />}
                  {link.slack_channel_name ?? link.slack_channel_id}
                </span>
                {link.paused && <span className="text-[10px] text-sol-text-dim">paused</span>}
                {!link.paused && link.last_error && <span className="text-[10px] text-sol-orange">needs attention</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
