import { memo } from "react";
import { Hash, Lock, Plus, BellOff } from "lucide-react";
import type { ChatChannelView } from "./chatTypes";
import "./chat.css";

// The channel rail.
//
// Three states have to be distinguishable at a glance without reading numbers:
// read (dim), unread (full strength and semibold), and mentioning you (a red
// count). Unread is carried by weight rather than colour because colour is
// already busy marking the active channel — using it for both makes neither
// legible.

export const ChatChannelRail = memo(function ChatChannelRail({
  channels,
  activeChannelId,
  onSelect,
  onCreate,
}: {
  channels: ChatChannelView[];
  activeChannelId?: string;
  onSelect: (channelId: string) => void;
  onCreate?: () => void;
}) {
  return (
    <nav className="ch-rail" aria-label="Channels">
      <div className="ch-rail-head">
        <span className="ch-rail-title">Channels</span>
        {onCreate && (
          <button type="button" className="ch-rail-add" title="New channel" onClick={onCreate}>
            <Plus className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      <div className="ch-rail-list">
        {channels.map((c) => {
          const unread = (c.unreadCount ?? 0) > 0;
          const mentions = c.mentionCount ?? 0;
          const active = c.id === activeChannelId;
          const cls = [
            "ch-chan",
            active ? "ch-chan-active" : "",
            // An active channel is being read, so it never also shouts unread.
            unread && !active ? "ch-chan-unread" : "",
            c.muted ? "ch-chan-muted" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={c.id}
              type="button"
              className={cls}
              onClick={() => onSelect(c.id)}
              aria-current={active ? "page" : undefined}
              title={c.topic || `#${c.name}`}
            >
              <span className="ch-chan-hash" aria-hidden="true">
                {c.isPrivate ? <Lock className="w-3 h-3" /> : <Hash className="w-3 h-3" />}
              </span>
              <span className="ch-chan-name">{c.name}</span>
              {c.muted && <BellOff className="w-3 h-3 shrink-0 opacity-70" aria-label="Muted" />}
              {mentions > 0 ? (
                <span className="ch-chan-badge" aria-label={`${mentions} mentions`}>
                  {mentions > 99 ? "99+" : mentions}
                </span>
              ) : (
                // A muted channel with unread messages gets a dot, not a count:
                // you asked not to be counted at, but the room is still alive.
                unread && !active && c.muted && <span className="ch-chan-dot" aria-label="Unread" />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
});
