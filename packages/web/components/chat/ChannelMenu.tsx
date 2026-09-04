import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, Bell, Pencil, Text } from "lucide-react";
import {
  ContextMenu,
  CtxCheckItem,
  CtxHeader,
  CtxItem,
  CtxLabel,
  CtxSeparator,
  type ContextMenuState,
} from "../ui/context-menu";
import type { ChannelMenuPayload } from "../../hooks/useChannelMenu";
import { useInboxStore } from "../../store/inboxStore";
import type { ChatNotifyLevel } from "../../store/chatSlice";
import { channelDisplayName } from "../../lib/chatViews";
import { dmOtherIds } from "@codecast/shared/chat";
import "./chat.css";

import { useWatchEffect } from "../../hooks/useWatchEffect";
// The one channel-management surface, on the app's one menu system.
//
// The menu itself is the shared context-menu primitive (ui/context-menu), so a
// channel's right-click looks and behaves like every other object's — same
// surface, same focus rules, same keycaps. What stays chat-specific is the
// CONTENT (notification level, rename, topic, archive) and the inline editor:
// text inputs do not belong inside a Radix menu (its typeahead and focus trap
// fight the field), so Rename/Set topic close the menu and hand the SAME anchor
// to a small editor popover.
//
// Every write is an optimistic store action; the server's creator-or-admin
// check reconciles afterward if it must.

// Slack's three levels, in Slack's words, so nobody has to learn a second
// vocabulary for the same idea. "Just mentions" is the join-time default and
// covers everything addressed to you: @you, @here, your threads, DMs.
const NOTIFY_LEVELS: { value: ChatNotifyLevel; label: string; hint: string }[] = [
  { value: "all", label: "All new posts", hint: "every message" },
  { value: "mentions", label: "Just mentions", hint: "default" },
  { value: "none", label: "Mute", hint: "badge only" },
];

export function ChannelContextMenu({ state }: { state: ContextMenuState<ChannelMenuPayload> }) {
  const setNotifyLevel = useInboxStore((s) => s.setChannelNotifyLevel);
  const archiveChannel = useInboxStore((s) => s.archiveChatChannel);
  const [editor, setEditor] = useState<{
    channelId: string;
    field: "name" | "topic";
    x: number;
    y: number;
  } | null>(null);

  return (
    <>
      <ContextMenu state={state}>
        {(p) => {
          const s = useInboxStore.getState();
          const channel = s.chatChannels[p.channelId];
          if (!channel) return null;
          // A DM has no name, no topic and no archive: its identity is who is
          // in it, so the menu offers exactly what remains — how loudly it may
          // interrupt. The header wears the same live-derived name as the rail.
          const isDm = channel.kind === "dm";
          const title = isDm
            ? channelDisplayName(
                { name: "", kind: "dm", dmMemberIds: dmOtherIds(channel.dm_key, (s as any).currentUser?._id ?? "") },
                (s as any).teamMembers,
              )
            : `#${channel.name}`;
          return (
            <>
              <CtxHeader title={title} />
              <CtxLabel>Notifications</CtxLabel>
              {NOTIFY_LEVELS.map((level) => (
                <CtxCheckItem
                  key={level.value}
                  checked={p.notifyLevel === level.value}
                  onCheckedChange={() => setNotifyLevel(p.channelId, level.value)}
                >
                  <span className="truncate">{level.label}</span>
                  <span className="ml-auto pl-4 text-[10.5px] text-sol-text-dim">{level.hint}</span>
                </CtxCheckItem>
              ))}
              {!isDm && <CtxSeparator />}
              {!isDm && <CtxItem
                icon={Pencil}
                onSelect={(e: Event) => {
                  // The menu closes; the editor opens at the same anchor.
                  e.preventDefault();
                  state.close();
                  setEditor({ channelId: p.channelId, field: "name", x: state.menu!.x, y: state.menu!.y });
                }}
              >
                Rename channel
              </CtxItem>}
              {!isDm && <CtxItem
                icon={Text}
                onSelect={(e: Event) => {
                  e.preventDefault();
                  state.close();
                  setEditor({ channelId: p.channelId, field: "topic", x: state.menu!.x, y: state.menu!.y });
                }}
              >
                {channel.topic ? "Edit topic" : "Set topic"}
              </CtxItem>}
              {!isDm && <CtxSeparator />}
              {!isDm && <CtxItem
                icon={Archive}
                danger
                onSelect={() => {
                  archiveChannel(p.channelId, true);
                  p.onArchived?.();
                }}
              >
                Archive channel
              </CtxItem>}
            </>
          );
        }}
      </ContextMenu>
      {editor && <ChannelFieldEditor {...editor} onClose={() => setEditor(null)} />}
    </>
  );
}

/** The rename/topic editor: a small anchored card, not a menu item. */
function ChannelFieldEditor({
  channelId,
  field,
  x,
  y,
  onClose,
}: {
  channelId: string;
  field: "name" | "topic";
  x: number;
  y: number;
  onClose: () => void;
}) {
  const channel = useInboxStore((s) => s.chatChannels[channelId]);
  const updateChannel = useInboxStore((s) => s.updateChatChannel);
  const [draft, setDraft] = useState(() =>
    field === "name" ? channel?.name ?? "" : channel?.topic ?? "",
  );
  const cardRef = useRef<HTMLDivElement | null>(null);

  useWatchEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (cardRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (!channel) return null;

  const commit = () => {
    const value = draft.trim();
    if (field === "name" && value && value !== channel.name) {
      updateChannel(channelId, { name: value });
    }
    if (field === "topic" && value !== (channel.topic ?? "")) {
      updateChannel(channelId, { topic: value });
    }
    onClose();
  };

  const left = Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 1200) - 300);
  const top = Math.min(y, (typeof window !== "undefined" ? window.innerHeight : 800) - 90);

  return createPortal(
    <div ref={cardRef} className="ch-channel-edit" style={{ left, top }}>
      <div className="ch-channel-edit-label">
        {field === "name" ? `Rename #${channel.name}` : `Topic for #${channel.name}`}
      </div>
      <div className="ch-channel-menu-edit">
        <input
          className="ch-channel-menu-input"
          value={draft}
          autoFocus
          placeholder={field === "name" ? "channel-name" : "What is this channel for?"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
        />
        <button type="button" className="ch-channel-menu-save" onClick={commit}>
          Save
        </button>
      </div>
    </div>,
    document.body,
  );
}
