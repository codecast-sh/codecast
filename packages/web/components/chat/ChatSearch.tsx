import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Hash, Loader2, Lock, Search, User, X } from "lucide-react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow, queryCircuitOpenError } from "../../hooks/useQueryNoThrow";
import { useInboxStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useDebounce } from "../../hooks/useDebounce";
import { CommentAvatar } from "../comments/CommentAvatar";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { ChatModalLegend } from "./ChatModalLegend";
import { highlightMatch } from "../GlobalSearch";
import { isConvexId } from "../../lib/entityLinks";
import { dmOtherIds, startOfDay } from "@codecast/shared/chat";
import { authorFor, channelDisplayName, memberHandles, memberName, type ChatMember } from "../../lib/chatViews";
import type { ChatChannelView } from "./chatTypes";
import "./chat.css";

import { useWatchEffect } from "../../hooks/useWatchEffect";
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

function uniqueOr<T>(xs: T[]): T | undefined {
  return xs.length === 1 ? xs[0] : undefined;
}

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
    if (!needle) return whole;
    if (op.toLowerCase() === "in") {
      // An exact slug wins; otherwise a UNIQUE prefix resolves as you type, so
      // "in:#des" already narrows to #design instead of searching literally.
      const rooms = channels.filter((x) => x.kind !== "dm");
      const c =
        rooms.find((x) => x.name.toLowerCase() === needle) ??
        uniqueOr(rooms.filter((x) => x.name.toLowerCase().startsWith(needle)));
      if (c) {
        channelId = c.id;
        inLabel = c.name;
        return " ";
      }
    } else {
      const answers = (x: ChatMember) => [
        ...memberHandles(x),
        memberName(x).toLowerCase(),
        memberName(x).split(/\s+/)[0]?.toLowerCase() ?? "",
      ];
      const m =
        members.find((x) => answers(x).includes(needle)) ??
        uniqueOr(members.filter((x) => answers(x).some((a) => a.startsWith(needle))));
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

/** Compact stamp for a hit row: a time today, "Yesterday" + time, else a short
 *  date — with the year once it differs, so two Augusts never read the same.
 *  Day boundaries come from startOfDay (shared/chat/timeline), not from
 *  now - 24h, which misses "yesterday" across a DST change. */
function hitStamp(ts: number, now: number): string {
  const d = new Date(ts);
  const day = startOfDay(ts);
  const today = startOfDay(now);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (day === today) return time;
  if (day === startOfDay(today - 1)) return `Yesterday ${time}`;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString([], { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
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

  useWatchEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(flat.length - 1, 0)));
  }, [flat.length]);
  useWatchEffect(() => {
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

  // Keys live on the INPUT so Enter on a focused button (close, a chip) still
  // clicks that button instead of jumping to the top hit.
  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
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

  // The chip's on/off state reads the LIVE text, not the debounced parse — a
  // second click inside the debounce window must toggle off, not insert twice.
  const inToken = `in:#${currentChannel?.name ?? ""}`;
  const inTokenRe = currentChannel ? new RegExp(`(?:^|\\s)in:#?${currentChannel.name}(?=\\s|$)`, "i") : null;
  const inThisLive = !!inTokenRe && inTokenRe.test(raw);
  const toggleInThis = () => {
    if (!currentChannel || !inTokenRe) return;
    setRaw((r) => (inTokenRe.test(r) ? r.replace(inTokenRe, " ").replace(/\s+/g, " ").trim() : `${inToken} ${r}`.replace(/\s+$/, "") + " "));
    inputRef.current?.focus();
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
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
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
            onKeyDown={onInputKeyDown}
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
              className={`ch-search-chip ${inThisLive ? "ch-search-chip-on" : ""}`}
              aria-pressed={inThisLive}
              onClick={toggleInThis}
            >
              <Hash className="w-3 h-3" />
              {currentChannel.name}
            </button>
          )}
          {parsed.inLabel && parsed.channelId !== currentChannelId && (
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
                Narrow with <code>in:#channel</code> or <code>from:@person</code>. <KeyCap size="xs">{"\u21a9"}</KeyCap> jumps to the message.
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
              <p>{error === queryCircuitOpenError ? "Search timed out." : "Search is not answering."}</p>
              <p className="ch-search-hint-sub">Try again in a moment, or narrow with a filter.</p>
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
                  <span className="ch-eyebrow-name">{label}</span>
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
                          <span className="ch-search-hit-time">{hitStamp(h.created_at, now)}</span>
                          {h.thread_root_id && <span className="ch-search-hit-thread">in thread</span>}
                        </span>
                        <span className="ch-search-hit-snippet">
                          {highlightMatch(h.snippet, parsed.q)}
                        </span>
                      </span>
                      <span className="ch-search-hit-go" aria-hidden="true"><KeyCap size="xs">{"\u21a9"}</KeyCap></span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
        <ChatModalLegend enterLabel="open" />
      </div>
    </div>
  );
}
