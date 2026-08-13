import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, Check, Pencil, Text } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import type { ChatNotifyLevel } from "../../store/chatSlice";
import "./chat.css";

// The one channel-management surface. The chat page header and the sidebar's
// channel rows both open THIS, so "what can I do to a channel" has a single
// answer: notification level, rename, topic, archive. Rename and topic edit
// inline; every write is an optimistic store action, so the rail and header
// update the moment you confirm and the server's creator-or-admin check
// reconciles afterward if it must.
//
// A portal at a fixed anchor rather than an in-flow dropdown: the sidebar rows
// live inside an overflow-hidden, animated container that would clip anything
// expanded in place.

const NOTIFY_LEVELS: { value: ChatNotifyLevel; label: string; hint: string }[] = [
  { value: "all", label: "All messages", hint: "Toast for every message" },
  { value: "mentions", label: "Mentions only", hint: "Only when you are named" },
  { value: "none", label: "Nothing", hint: "Muted — badge only" },
];

export function ChannelMenu({
  channelId,
  notifyLevel,
  anchor,
  onClose,
  onArchived,
}: {
  channelId: string;
  notifyLevel: ChatNotifyLevel;
  /** Viewport coordinates of the button that opened the menu. */
  anchor: { x: number; y: number };
  onClose: () => void;
  /** The opener decides where the view goes after the room disappears. */
  onArchived?: () => void;
}) {
  const channel = useInboxStore((s) => s.chatChannels[channelId]);
  const setNotifyLevel = useInboxStore((s) => s.setChannelNotifyLevel);
  const updateChannel = useInboxStore((s) => s.updateChatChannel);
  const archiveChannel = useInboxStore((s) => s.archiveChatChannel);

  const [editing, setEditing] = useState<"name" | "topic" | null>(null);
  const [draft, setDraft] = useState("");
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
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

  const beginEdit = (field: "name" | "topic") => {
    setDraft(field === "name" ? channel.name : channel.topic ?? "");
    setEditing(field);
  };

  const commitEdit = () => {
    const value = draft.trim();
    if (editing === "name" && value && value !== channel.name) {
      updateChannel(channelId, { name: value });
    }
    if (editing === "topic" && value !== (channel.topic ?? "")) {
      updateChannel(channelId, { topic: value });
    }
    setEditing(null);
  };

  // Clamped so a menu opened near the viewport's bottom-right stays on screen.
  const left = Math.min(anchor.x, (typeof window !== "undefined" ? window.innerWidth : 1200) - 268);
  const top = Math.min(anchor.y, (typeof window !== "undefined" ? window.innerHeight : 800) - 320);

  return createPortal(
    <div ref={cardRef} className="ch-channel-menu" role="menu" style={{ left, top }}>
      <div className="ch-channel-menu-head">#{channel.name}</div>

      <div className="ch-channel-menu-label">Notifications</div>
      {NOTIFY_LEVELS.map((level) => (
        <button
          key={level.value}
          type="button"
          role="menuitemradio"
          aria-checked={notifyLevel === level.value}
          className="ch-channel-menu-item"
          onClick={() => {
            setNotifyLevel(channelId, level.value);
            onClose();
          }}
        >
          <span className="ch-channel-menu-check">
            {notifyLevel === level.value && <Check className="w-3 h-3" />}
          </span>
          <span className="min-w-0">
            <span className="ch-channel-menu-item-label">{level.label}</span>
            <span className="ch-channel-menu-hint">{level.hint}</span>
          </span>
        </button>
      ))}

      <div className="ch-channel-menu-rule" />

      {editing ? (
        <div className="ch-channel-menu-edit">
          <input
            className="ch-channel-menu-input"
            value={draft}
            autoFocus
            placeholder={editing === "name" ? "channel-name" : "What is this channel for?"}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitEdit();
              }
              if (e.key === "Escape") {
                e.stopPropagation();
                setEditing(null);
              }
            }}
          />
          <button type="button" className="ch-channel-menu-save" onClick={commitEdit}>
            Save
          </button>
        </div>
      ) : (
        <>
          <button type="button" role="menuitem" className="ch-channel-menu-item" onClick={() => beginEdit("name")}>
            <span className="ch-channel-menu-check">
              <Pencil className="w-3 h-3" />
            </span>
            <span className="ch-channel-menu-item-label">Rename channel</span>
          </button>
          <button type="button" role="menuitem" className="ch-channel-menu-item" onClick={() => beginEdit("topic")}>
            <span className="ch-channel-menu-check">
              <Text className="w-3 h-3" />
            </span>
            <span className="ch-channel-menu-item-label">{channel.topic ? "Edit topic" : "Set topic"}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="ch-channel-menu-item ch-channel-menu-danger"
            onClick={() => {
              archiveChannel(channelId, true);
              onClose();
              onArchived?.();
            }}
          >
            <span className="ch-channel-menu-check">
              <Archive className="w-3 h-3" />
            </span>
            <span className="min-w-0">
              <span className="ch-channel-menu-item-label">Archive channel</span>
              <span className="ch-channel-menu-hint">Hides it for everyone; history kept</span>
            </span>
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
