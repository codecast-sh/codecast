"use client";

// Under the team's Slack card: which chat channels mirror which Slack channels.
// Reads the store (chat.listChannels feeds chatSlackLinks), so it is honest
// about the active team and paints from cache. The per-channel controls live in
// the channel's own dialog; this is the team-wide glance and the way there.
import Link from "next/link";
import { useState } from "react";
import { ChevronRight, Hash, Loader2, Lock, Plus } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useChatMembers, useChatRail } from "../../hooks/useChatSync";
import { channelDisplayName } from "../../lib/chatViews";
import { SlackReconnect } from "../chat/ChannelPeople";
import { DIRECTION_ARROW } from "@codecast/convex/convex/lib/slackMirror";
import { useTrackedStore } from "../../store/inboxStore";
import { SlackChannelBrowser } from "../chat/SlackChannelBrowser";
import { SlackPeopleDialog } from "../chat/SlackPeopleDialog";
import { SlackDmSwitch } from "../chat/SlackDmSwitch";
import { UserRound } from "lucide-react";
import { QuietButton } from "./parts";
import { slackLinksSig } from "../../hooks/useChatSync";
import type { ChatSlackLinkRow } from "../../store/chatSlice";

export function SlackMirrorsSummary() {
  const s = useTrackedStore([
    (st) => slackLinksSig(st.chatSlackLinks as any),
    (st) => Object.keys(st.chatChannels ?? {}).length,
    (st) => st.clientState?.ui?.active_team_id,
  ]);
  const teamId = s.clientState?.ui?.active_team_id ? String(s.clientState.ui.active_team_id) : undefined;
  const [browsing, setBrowsing] = useState(false);
  const [people, setPeople] = useState(false);
  const team = useQueryNoThrow(api.slackSync.getTeamSlack, teamId ? ({ team_id: teamId } as any) : "skip").data as
    | { missing_scopes?: string[]; is_admin?: boolean }
    | null
    | undefined;
  const [dmsOpen, setDmsOpen] = useState(false);
  const links = Object.values(s.chatSlackLinks ?? {}) as ChatSlackLinkRow[];
  const rows = links
    .filter((l) => l.kind !== "dm")
    .map((l) => ({ link: l, channel: s.chatChannels[l.chat_channel_id] }))
    .filter((r) => !!r.channel)
    .sort((a, b) => (a.channel!.name ?? "").localeCompare(b.channel!.name ?? ""));
  // A mirrored DM is named the way the chat rail names it: the other side.
  const rail = useChatRail();
  const { members } = useChatMembers();
  const dmLinks = links.filter((l) => l.kind === "dm");
  const dmRows = dmLinks
    .map((link) => {
      const view = rail.find((c) => c.id === link.chat_channel_id);
      return { link, name: view ? channelDisplayName(view, members) : "Direct message" };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const dmTrouble = dmLinks.filter((l) => !l.paused && l.last_error).length;

  return (
    <div className="mt-3 border-t border-sol-border/40 pt-3">
      <div className="flex items-center gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.09em] text-sol-text-dim">Mirrored from Slack</div>
        {teamId && (
          <span className="ml-auto inline-flex items-center gap-2">
            <QuietButton onClick={() => setPeople(true)}>
              <span className="inline-flex items-center gap-1"><UserRound className="w-3 h-3" /> People</span>
            </QuietButton>
            <QuietButton onClick={() => setBrowsing(true)}>
              <span className="inline-flex items-center gap-1"><Plus className="w-3 h-3" /> Add channels from Slack</span>
            </QuietButton>
          </span>
        )}
      </div>
      {teamId && !!team?.missing_scopes?.length && (
        <SlackReconnect teamId={teamId} returnTo="/settings/integrations?slack=connected" isAdmin={!!team.is_admin} isPrivate={false} />
      )}
      {teamId && <div className="mt-2"><SlackDmSwitch teamId={teamId} compact /></div>}
      {dmRows.length > 0 && (
        <div className="mt-1">
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[11px] text-sol-text-muted hover:text-sol-text"
            aria-expanded={dmsOpen}
            onClick={() => setDmsOpen((o) => !o)}
          >
            <ChevronRight className={`w-3 h-3 transition-transform ${dmsOpen ? "rotate-90" : ""}`} />
            {dmsOpen ? "Hide" : "Show"} {dmRows.length} direct message{dmRows.length === 1 ? "" : "s"}
            {dmTrouble > 0 && <span className="text-sol-orange"> · {dmTrouble} need{dmTrouble === 1 ? "s" : ""} attention</span>}
          </button>
          {dmsOpen && (
            <ul className="mt-1 ml-4 flex flex-col gap-1">
              {dmRows.map(({ link, name }) => (
                <li key={link._id} className="flex items-center gap-2 text-[11.5px]">
                  <Link href={`/chat/${link.chat_channel_id}`} className="truncate text-sol-text hover:underline">{name}</Link>
                  {link.paused && <span className="text-[10px] text-sol-text-dim">paused</span>}
                  {!link.paused && link.last_error && (
                    <span className="text-[10px] text-sol-orange" title={link.last_error}>needs attention</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {browsing && teamId && <SlackChannelBrowser teamId={teamId} onClose={() => setBrowsing(false)} />}
      {people && teamId && <SlackPeopleDialog teamId={teamId} onClose={() => setPeople(false)} />}
      {rows.length > 0 && (
        <div className="mt-3 text-[10px] font-semibold uppercase tracking-[0.09em] text-sol-text-dim">Channels</div>
      )}
      {rows.length === 0 ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-sol-text-dim">
          None yet. Bring Slack channels over with the button above, or open a channel in Chat and choose{" "}
          <span className="text-sol-text-muted">Mirror with Slack</span> from its menu.
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
                {/* The channel wears the Slack name, so the far side is just
                    "Slack"; a name kept apart (taken on our side) is spelled out. */}
                <span className="inline-flex items-center gap-0.5 text-sol-text-muted">
                  {(link.slack_channel_name ?? link.slack_channel_id) === channel!.name ? (
                    "Slack"
                  ) : (
                    <>
                      {link.slack_channel_private ? <Lock className="w-3 h-3" /> : <Hash className="w-3 h-3" />}
                      {link.slack_channel_name ?? link.slack_channel_id}
                    </>
                  )}
                </span>
                {link.backfill?.status === "running" && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-sol-green">
                    <Loader2 className="w-3 h-3 animate-spin" /> importing · {link.backfill.fetched.toLocaleString()} lines
                  </span>
                )}
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
