import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeft, Hash, Loader2, Lock, Search, User, X } from "lucide-react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useInboxStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useDebounce } from "../../hooks/useDebounce";
import { CommentAvatar } from "../comments/CommentAvatar";
import { highlightMatch } from "../GlobalSearch";
import { isConvexId } from "../../lib/entityLinks";
import { dmOtherIds } from "@codecast/shared/chat";
import { authorFor, channelDisplayName, memberHandles, memberName, type ChatMember } from "../../lib/chatViews";
import type { ChatChannelView } from "./chatTypes";
import "./chat.css";

const api = _api as any;

// Chat search.
//
// One input searches every room the viewer can read; the grammar carries the
// filters — `in:#channel` and `from:@person` — the way Slack's does, so a
// power user never leaves the keyboard and a filter is visible IN the query it
// narrows. The panel is transient by design: results are a server-ranked read
// (never store state), and Enter leaves through the permalink machinery the
// notifications already use, landing highlighted on the exact message.

const NO_HITS: SearchHit[] = [];

type SearchHit = {
  _id: string;
  channel_id: string;
  channel_name: string;
  channel_kind?: string;
  dm_key?: string;
  thread_root_id?: string;
  user_id: string;
  author_kind: "user" | "agent";
  created_at: number;
  snippet: string;
  permalink: string;
};

/** `in:` and `from:` tokens leave the text and become filters. A token that
 *  resolves to nothing stays in the text — searching for it literally is more
 *  honest than silently dropping half the query. */
function parseGrammar(
  raw: string,
  channels: ChatChannelView[],
  members: ChatMember[],
): { q: string; channelId?: string; fromId?: string; inLabel?: string; fromLabel?: string } {
  let channelId: string | undefined;
  let fromId: string | undefined;
  let inLabel: string | undefined;
  let fromLabel: string | undefined;
  const rest = raw.replace(/(?:^|\s)(in|from):(\S+)/gi, (whole, op: string, arg: string) => {
    const needle = arg.replace(/^[#@]/, "").toLowerCase();
    if (op.toLowerCase() === "in") {
      const c = channels.find((x) => x.kind !== "dm" && x.name.toLowerCase() === needle);
      if (c) {
        channelId = c.id;
        inLabel = c.name;
        return " ";
      }
    } else {
      const m = members.find(
        (x) =>
          memberHandles(x).includes(needle) ||
          memberName(x).toLowerCase() === needle ||
          memberName(x).split(/\s+/)[0]?.toLowerCase() === needle,
      );
      if (m) {
        fromId = String(m._id);
        fromLabel = memberName(m);
        return " ";
      }
    }
    return whole;
  });
  return { q: rest.replace(/\s+/g, " ").trim(), channelId, fromId, inLabel, fromLabel };
}

function dayLabel(ts: number, now: number): string {
  const d = new Date(ts);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (sameDay(d, today)) return time;
  if (sameDay(d, yesterday)) return `Yesterday ${time}`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function ChatSearch({
  channels,
  currentChannelId,
  initialQuery,
  onClose,
}: {
  channels: ChatChannelView[];
  /** The room the search opened from — offered as a one-click `in:` filter. */
  currentChannelId?: string;
  initialQuery?: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const now = useCoarseNow(30_000);
  const teamMembers = useInboxStore((s) => s.teamMembers) as ChatMember[];
  const viewer = useInboxStore((s) => (s as any).currentUser?._id ?? "");
  const teamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as string | undefined;

  const [raw, setRaw] = useState(initialQuery ?? "");
  const debounced = useDebounce(raw, 250);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const byId = useMemo(
    () => new Map((teamMembers ?? []).map((m) => [String(m._id), m])),
    [teamMembers],
  );
  const parsed = useMemo(
    () => parseGrammar(debounced, channels, teamMembers ?? []),
    [debounced, channels, teamMembers],
  );

  const ready = parsed.q.length >= 2 && !!teamId && isConvexId(teamId);
  const { data, error } = useQueryNoThrow(
    api.chat.searchMessages,
    ready
      ? {
          team_id: teamId,
          q: parsed.q,
          ...(parsed.channelId && isConvexId(parsed.channelId) ? { channel_id: parsed.channelId } : {}),
          ...(parsed.fromId ? { from_user_id: parsed.fromId } : {}),
          limit: 30,
        }
      : "skip",
    { breakAfterMs: 15_000 },
  );
  const hits: SearchHit[] = ready ? (data?.results ?? NO_HITS) : NO_HITS;
  const loading = ready && data === undefined && !error;

  // Group by room, keeping the server's relevance order: a room ranks where its
  // best hit ranked, which is how the eye expects a grouped list to read.
  const groups = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, SearchHit[]>();
    for (const h of hits) {
      if (!map.has(h.channel_id)) {
        map.set(h.channel_id, []);
        order.push(h.channel_id);
      }
      map.get(h.channel_id)!.push(h);
    }
    return order.map((id) => ({ id, hits: map.get(id)! }));
  }, [hits]);
  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups]);

  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(flat.length - 1, 0)));
  }, [flat.length]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  // The room's name comes from the ONE naming rule (chatViews.channelDisplayName)
  // — a DM is the other side, first names only past a 1:1 — so the search
  // header can never disagree with the rail beside it.
  const roomLabel = (h: SearchHit): { icon: React.ReactNode; label: string } => {
    const label = channelDisplayName(
      { name: h.channel_name || "unknown", kind: h.channel_kind as any, dmMemberIds: dmOtherIds(h.dm_key, String(viewer)) },
      teamMembers,
    );
    if (h.channel_kind === "dm") return { icon: <User className="w-3 h-3" />, label };
    const priv = channels.find((c) => c.id === h.channel_id)?.isPrivate;
    return { icon: priv ? <Lock className="w-3 h-3" /> : <Hash className="w-3 h-3" />, label };
  };

  const open = (h: SearchHit | undefined) => {
    if (!h) return;
    onClose();
    router.push(h.permalink);
  };

  const currentChannel = channels.find((c) => c.id === currentChannelId && c.kind !== "dm");
  const inThisApplied = !!parsed.channelId && parsed.channelId === currentChannelId;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return onClose();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (flat.length ? (h + 1) % flat.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (flat.length ? (h - 1 + flat.length) % flat.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      open(flat[highlight]);
    }
  };

  let flatIdx = -1;
  return (
    <div className="ch-modal-overlay ch-search-overlay" onClick={onClose} role="presentation">
      <div
        className="ch-modal ch-search"
        role="dialog"
        aria-modal="true"
        aria-label="Search messages"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="ch-search-bar">
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin ch-search-bar-icon" />
          ) : (
            <Search className="w-4 h-4 ch-search-bar-icon" />
          )}
          <input
            ref={inputRef}
            value={raw}
            autoFocus
            placeholder="Search messages — in:#channel from:@person"
            onChange={(e) => {
              setRaw(e.target.value);
              setHighlight(0);
            }}
          />
          <button type="button" className="ch-modal-close" aria-label="Close" onClick={onClose}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="ch-search-chips">
          {currentChannel && (
            <button
              type="button"
              className={`ch-search-chip ${inThisApplied ? "ch-search-chip-on" : ""}`}
              onClick={() => {
                const token = `in:#${currentChannel.name}`;
                setRaw((r) =>
                  inThisApplied ? r.replace(new RegExp(`\\s*in:#?${currentChannel.name}`, "i"), "").trim()
                    : `${token} ${r}`.trim() + (r ? "" : " "),
                );
                inputRef.current?.focus();
              }}
            >
              <Hash className="w-3 h-3" />
              {currentChannel.name}
            </button>
          )}
          {parsed.inLabel && !inThisApplied && (
            <span className="ch-search-chip ch-search-chip-on">
              <Hash className="w-3 h-3" />
              {parsed.inLabel}
            </span>
          )}
          {parsed.fromLabel && (
            <span className="ch-search-chip ch-search-chip-on">
              <User className="w-3 h-3" />
              {parsed.fromLabel}
            </span>
          )}
          {flat.length > 0 && (
            <span className="ch-search-count">
              {flat.length}{flat.length === 30 ? "+" : ""} {flat.length === 1 ? "result" : "results"}
            </span>
          )}
        </div>

        <div className="ch-search-list" ref={listRef} role="listbox" aria-label="Search results">
          {!ready && (
            <div className="ch-search-hint">
              <p>Search every conversation you can read.</p>
              <p className="ch-search-hint-sub">
                Narrow with <code>in:#channel</code> or <code>from:@person</code>. Enter jumps to the message.
              </p>
            </div>
          )}
          {ready && loading && (
            <div className="ch-search-skel" role="status" aria-label="Searching">
              {[0, 1, 2].map((i) => (
                <div className="ch-skel-row" key={i}>
                  <div className="ch-skel-avatar" />
                  <div className="ch-skel-lines">
                    <div className="ch-skel-line ch-skel-head" />
                    <div className="ch-skel-line" style={{ width: `${70 - i * 12}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
          {ready && !!error && (
            <div className="ch-search-hint">
              <p>Search gave up on this one.</p>
              <p className="ch-search-hint-sub">Try fewer or more specific words.</p>
            </div>
          )}
          {ready && !loading && !error && flat.length === 0 && (
            <div className="ch-search-hint">
              <p>No messages match.</p>
              <p className="ch-search-hint-sub">Different words, or drop a filter.</p>
            </div>
          )}
          {groups.map((g) => {
            const { icon, label } = roomLabel(g.hits[0]);
            return (
              <div key={g.id} className="ch-search-group">
                <div className="ch-eyebrow ch-search-room">
                  <span aria-hidden="true">{icon}</span>
                  {label}
                </div>
                {g.hits.map((h) => {
                  flatIdx++;
                  const idx = flatIdx;
                  const author = authorFor(h.user_id, h.author_kind, byId as any);
                  return (
                    <button
                      key={h._id}
                      type="button"
                      data-idx={idx}
                      role="option"
                      aria-selected={idx === highlight}
                      className={`ch-search-hit ${idx === highlight ? "ch-row-hot" : ""}`}
                      onMouseMove={() => setHighlight(idx)}
                      onClick={() => open(h)}
                    >
                      <CommentAvatar
                        name={author.name}
                        image={author.avatarUrl}
                        isAgent={author.isAgent}
                        size={22}
                        letters={1}
                      />
                      <span className="ch-search-hit-body">
                        <span className="ch-search-hit-head">
                          <span className="ch-search-hit-author">{author.name}</span>
                          <span className="ch-search-hit-time">{dayLabel(h.created_at, now)}</span>
                          {h.thread_root_id && <span className="ch-search-hit-thread">in thread</span>}
                        </span>
                        <span className="ch-search-hit-snippet">
                          {highlightMatch(h.snippet, parsed.q)}
                        </span>
                      </span>
                      <CornerDownLeft className="w-3 h-3 ch-search-hit-go" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
