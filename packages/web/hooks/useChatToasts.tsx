import { useCallback, useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import {
  useInboxStore,
  useTrackedStore,
  type ChatMessageRow,
  type ChatNotifyLevel,
  type ChatRailRow,
} from "../store/inboxStore";
import { chatToastTier, type ChatToastTier } from "../lib/chatTimeline";
import { ChatToast, toastPreview, type ChatToastData } from "../components/chat/ChatToast";
import { isChatContextOnScreen } from "../lib/chatFocus";
import { isChatRailLive, subscribeChatRailLive } from "../lib/chatLive";
import { knownAgentMember, memberName, type ChatMember } from "../lib/chatViews";
import { soundChatMessage } from "../lib/sounds";
import { channelDisplayName } from "../lib/chatViews";
import { dmOtherIds } from "@codecast/shared/chat";

import { useWatchEffect } from "./useWatchEffect";
// Arriving chat messages → in-app toasts.
//
// Mounted once, app-wide, beside the other background sync effects — the point
// of a toast is to reach someone who is NOT looking at chat, so binding it to
// the chat page would fire it exactly when it is least needed.
//
// The arrival signal is the channel rail (chat.listChannels), not the message
// feed: the rail is the one chat subscription that runs everywhere, and it
// already carries the newest message, its author and a sanitized preview. When
// the channel happens to be open its full row is in the store too, and that row
// is preferred — it knows about mentions and threads, which the rail cannot say.
//
// chatToastTier owns the policy. Nothing here decides whether to interrupt; it
// only gathers the inputs honestly and renders what the tier asks for.

/** How long a channel's toasts count toward its burst cap. */
const BURST_WINDOW_MS = 45_000;
const LOUD_DURATION_MS = 9_000;
const QUIET_DURATION_MS = 4_500;

type Seen = { messageId: string; unread: number; mentions: number };

export function useChatToasts(): void {
  const router = useRouter();
  const s = useTrackedStore([
    (s: any) => railKey(s.chatRail),
    (s: any) => s.currentUser?._id,
  ]);
  const viewerId = String(s.currentUser?._id ?? "");
  // The rail is persisted and hydrates from IndexedDB before any query answers,
  // so "a rail exists" is not "a rail arrived". Until the server has answered
  // once, nothing here is an arrival — see lib/chatLive.
  const railLive = useSyncExternalStore(
    subscribeChatRailLive,
    isChatRailLive,
    () => false,
  );

  // Per channel: the last arrival we have already reacted to, plus the unread
  // numbers at that moment (so a burst can be counted without a message feed).
  const seenRef = useRef<Map<string, Seen>>(new Map());
  // Seeded on the first LIVE rail. Seeding from the cached one instead made a
  // reload toast every channel whose newest message moved while the app was
  // closed — the cold-boot flood this guard exists to prevent, arriving through
  // the one door it was not watching.
  const seededRef = useRef(false);
  const burstRef = useRef<Map<string, number[]>>(new Map());

  const open = useCallback(
    (data: ChatToastData) => {
      toast.dismiss(toastIdFor(data));
      router.push(`/chat/${data.channelId}?m=${data.messageId}`);
    },
    [router],
  );

  const mute = useCallback((channelId: string) => {
    const state: any = useInboxStore.getState();
    // Muting must not be SILENT: a one-click mute with no feedback reads as
    // "the toast went away" and leaves the channel dead for weeks before anyone
    // connects the missing notifications to that click.
    const prior: ChatNotifyLevel =
      (state.chatRail ?? []).find((r: ChatRailRow) => String(r.channel_id) === channelId)
        ?.notify_level ?? "all";
    const name = state.chatChannels?.[channelId]?.name ?? "channel";
    state.setChannelNotifyLevel(channelId, "none");
    toast.dismiss(`chat:${channelId}`);
    toast(`Muted #${name}`, {
      description: "No more notifications from this channel.",
      action: {
        label: "Undo",
        onClick: () => useInboxStore.getState().setChannelNotifyLevel(channelId, prior),
      },
    });
  }, []);

  const snooze = useCallback((minutes: number) => {
    useInboxStore.getState().updateClientUI({ chat_snooze_until: Date.now() + minutes * 60_000 });
    toast.dismiss();
  }, []);

  useWatchEffect(() => {
    const state: any = useInboxStore.getState();
    const rail: ChatRailRow[] = state.chatRail ?? [];
    if (!viewerId || rail.length === 0 || !railLive) return;

    const seen = seenRef.current;
    if (!seededRef.current) {
      seededRef.current = true;
      for (const row of rail) {
        seen.set(String(row.channel_id), {
          messageId: String(row.last_message?._id ?? ""),
          unread: row.unread ?? 0,
          mentions: row.unread_mentions ?? 0,
        });
      }
      return;
    }

    const messages: Record<string, ChatMessageRow> = state.chatMessages ?? {};
    const channels: Record<string, any> = state.chatChannels ?? {};
    const members: any[] = state.teamMembers ?? [];
    const byId = new Map<string, ChatMember>();
    for (const m of members) if (m?._id) byId.set(String(m._id), m);
    const snoozedUntil: number = state.clientState?.ui?.chat_snooze_until ?? 0;
    const windowFocused = typeof document === "undefined" ? true : document.hasFocus();

    for (const row of rail) {
      const channelId = String(row.channel_id);
      const last = row.last_message;
      const prev = seen.get(channelId);
      seen.set(channelId, {
        messageId: String(last?._id ?? ""),
        unread: row.unread ?? 0,
        mentions: row.unread_mentions ?? 0,
      });
      if (!last || !prev) continue;
      const messageId = String(last._id);
      if (messageId === prev.messageId) continue;
      if (last.user_id === viewerId) continue;

      const full = messages[messageId];
      // The rail cannot say whether a message named you; a rise in the server's
      // own mention count can, and the full row says so outright when we have it.
      const mentionsViewer = full
        ? full.mention_scope === "here" || !!full.mentions?.includes(viewerId)
        : (row.unread_mentions ?? 0) > prev.mentions;
      const threadRootId = full?.thread_root_id;
      const viewerInThread =
        !!threadRootId &&
        Object.values(messages).some(
          (m) => m.thread_root_id === threadRootId && m.user_id === viewerId,
        );

      const recent = (burstRef.current.get(channelId) ?? []).filter(
        (t) => Date.now() - t < BURST_WINDOW_MS,
      );
      const channelRow = channels[channelId];
      const isDm = channelRow?.kind === "dm";
      // Any registered surface showing this exact channel+thread context
      // counts as "already on screen" — the tier's compare stays byte-for-byte
      // the same, it just answers against every hold instead of one slot.
      const onScreen = isChatContextOnScreen(channelId, threadRootId ?? undefined);
      const tier: ChatToastTier = chatToastTier({
        authorId: String(last.user_id),
        viewerId,
        mentionsViewer,
        isDm,
        channelId,
        activeChannelId: onScreen ? channelId : undefined,
        activeThreadRootId: onScreen ? threadRootId ?? undefined : undefined,
        threadRootId,
        viewerInThread,
        answersViewer: last.author_kind === "agent" && !!viewerInThread,
        windowFocused,
        channelMuted: row.notify_level === "none",
        notifyLevel: row.notify_level,
        doNotDisturb: snoozedUntil > Date.now(),
        recentToastsFromChannel: recent.length,
      });
      if (tier === "silent") continue;

      recent.push(Date.now());
      burstRef.current.set(channelId, recent);

      const author = byId.get(String(last.user_id)) ?? knownAgentMember(String(last.user_id));
      const isAgent = last.author_kind === "agent" || !!author?.is_bot;
      const data: ChatToastData = {
        messageId,
        channelId,
        channelName: isDm
          ? channelDisplayName(
              { name: "", kind: "dm", dmMemberIds: dmOtherIds(channelRow?.dm_key, viewerId) },
              members,
            )
          : channelRow?.name ?? "channel",
        isDm,
        authorName: memberName(author),
        authorAvatarUrl: isAgent ? undefined : author?.image || author?.github_avatar_url,
        authorIsAgent: isAgent,
        preview: toastPreview(full?.content ?? last.preview ?? ""),
        tier,
        // How many messages this card stands in for: the server's unread count
        // moved by more than one while we were away.
        collapsedCount: Math.max(1, (row.unread ?? 0) - prev.unread),
        inThread: !!threadRootId,
      };

      // Every card gets the sound (Slack's rule: a banner is never silent).
      // The tier still decides the card's dwell and accent; the sound is one
      // sound so nobody learns to ignore the "ordinary" one.
      soundChatMessage(messageId);
      toast.custom(
        () => <ChatToast data={data} onOpen={open} onMuteChannel={mute} onSnooze={snooze} />,
        {
          // A loud card keeps its own slot (it is about you, and a second mention
          // must not silently replace the first). Quiet cards from one channel
          // collapse onto one id, which is what makes a busy room one card.
          id: toastIdFor(data),
          duration: tier === "loud" ? LOUD_DURATION_MS : QUIET_DURATION_MS,
        },
      );
    }
  }, [s, viewerId, railLive, open, mute, snooze]);
}

function toastIdFor(data: ChatToastData): string {
  return data.tier === "loud" ? `chat-loud:${data.messageId}` : `chat:${data.channelId}`;
}

/** Wake only on a real rail change: a new newest-message, or a moved count. */
function railKey(rail: ChatRailRow[] | undefined): string {
  let out = "";
  for (const r of rail ?? []) {
    out += `${r.channel_id}:${r.last_message?._id ?? ""}:${r.unread}:${r.unread_mentions}:${r.notify_level};`;
  }
  return out;
}
