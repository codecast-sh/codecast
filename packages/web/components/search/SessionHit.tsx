// One conversation a search found, the way every search surface draws it (the
// /search page and the top bar's results): the head is the inbox card's own
// identity (face, name and title, project chip, author, age) and under it the
// messages that matched, each drawn as its transcript draws it (MatchSnippet).
// A session found only by its name shows what it was about instead: the
// summary its card shows, or the stretch the instant tier matched.
import { memo, type MouseEvent } from "react";
import Link from "next/link";
import { SessionGlyph, SessionIdentityLine } from "../identity";
import { identityRowOf } from "../../lib/sessionIdentity";
import { cleanTitle } from "../../lib/conversationProcessor";
import { getProjectName } from "../../store/inboxStore";
import { SessionProjectChip } from "../inbox/SessionCardParts";
import { AuthorAvatar, MetaDot } from "../entityDisplay";
import { formatSearchTimestamp } from "../../lib/searchTimestamp";
import { highlightMatch, getSnippet, stripSnippetMarkup } from "../../lib/searchHighlight";
import type { SessionSearchRow } from "../../lib/instantSessionSearch";
import { SearchOrigin } from "./SearchOrigin";
import { MatchSnippet, SpeakerLine } from "./MatchSnippet";
import { AgentTypeIcon } from "../AgentTypeIcon";
import { useModeWords, useSurface } from "../../lib/surfaces";

export type SessionHitRow = SessionSearchRow;

export const SessionHit = memo(function SessionHit({
  row, highlight, hrefFor, selected = false, maxMatches = 3, onHover, onSessionMenu, onMatchMenu, onNavigate,
}: {
  row: SessionHitRow;
  /** The words searched for (operators stripped). */
  highlight: string;
  /** The conversation's address, at a message when one is named. */
  hrefFor: (row: SessionHitRow, messageId?: string) => string;
  selected?: boolean;
  /** Matched messages shown before "N more". */
  maxMatches?: number;
  onHover?: () => void;
  onSessionMenu?: (e: MouseEvent) => void;
  onMatchMenu?: (e: MouseEvent, messageId: string) => void;
  /** Called on any open, so a surface that floats (the top bar's panel) can close. */
  onNavigate?: () => void;
}) {
  const internals = useSurface("search.internals");
  const words = useModeWords();
  const identity = identityRowOf({ _id: row.conversationId, title: row.title, ...(row.identity ?? {}) });
  const project = getProjectName(row.projectPath ?? undefined);
  // A request sent again (Try again) matches twice with the same words; it shows once.
  const seen = new Set<string>();
  const matches = row.matches.filter((m) => {
    const key = `${m.role}\u0000${m.content.trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const shown = matches.slice(0, maxMatches);
  // A hit on the first message says what the "began as" line already says:
  // the message shows, the line goes.
  const flat = (t: string) => stripSnippetMarkup(t).replace(/^\.\.\.|\.\.\.$/g, "").toLowerCase().slice(0, 80);
  const began = row.origin?.started_as;
  const origin = began && shown.some((m) => flat(m.content).includes(flat(began).slice(0, 60)) || flat(began).includes(flat(m.content).slice(0, 60)))
    ? { ...row, origin: { ...row.origin, started_as: undefined } }
    : row;
  const more = Math.max(0, (row.matchCount ?? matches.length) - shown.length);

  return (
    <div
      data-search-session={row.conversationId}
      data-selected={selected || undefined}
      onMouseEnter={onHover}
      className={`rounded-lg border transition-colors ${
        selected ? "border-sol-border bg-sol-bg-alt shadow-sm" : "border-transparent hover:border-sol-border/60 hover:bg-sol-bg-alt/60"
      }`}
    >
      <Link
        href={hrefFor(row)}
        onClick={onNavigate}
        onContextMenu={onSessionMenu}
        className="block px-3 pt-2.5 pb-1.5 no-underline"
      >
        <div className="flex min-w-0 items-center gap-2">
          <SessionGlyph
            row={identity}
            size={18}
            className="flex-shrink-0"
            fallback={!row.isOwn && (row.authorAvatar || row.authorName)
              ? <AuthorAvatar name={row.authorName} avatar={row.authorAvatar} size={18} />
              : <span className="flex h-[18px] w-[18px] items-center justify-center"><AgentTypeIcon agentType={row.agentType || "claude_code"} className="h-3.5 w-3.5" /></span>}
          />
          <SessionIdentityLine row={identity} title={cleanTitle(row.title || "Untitled")} highlight={highlight} className="min-w-0 flex-1 text-[14px]" />
          <span className="flex-shrink-0 text-[11px] tabular-nums text-sol-text-dim">{formatSearchTimestamp(row.updatedAt)}</span>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 pl-[26px] text-[10px] text-sol-text-muted">
          {!row.isOwn && row.authorName && <span className="flex-shrink-0 font-medium text-sol-violet/80">{row.authorName.split(" ")[0]}</span>}
          <SessionProjectChip project={project} directory={row.projectPath} />
          {internals && !!row.messageCount && <><MetaDot /><span className="flex-shrink-0 tabular-nums">{row.messageCount} msgs</span></>}
        </div>
        <SearchOrigin row={origin} query={highlight} className="mt-1 pl-[26px]" />
        {shown.length === 0 && row.instantSnippet && (
          <p className="mt-1 line-clamp-2 pl-[26px] text-[12px] leading-relaxed text-sol-text-secondary">
            {highlightMatch(getSnippet(row.instantSnippet, highlight, 220), highlight)}
          </p>
        )}
      </Link>
      {shown.length > 0 && (
        <div className="ml-[26px] mr-1 mb-1.5 border-l border-sol-border/50 pl-1">
          {shown.map((m) => (
            <MatchSnippet
              key={m.messageId ?? m.content}
              content={m.content}
              timestamp={m.timestamp}
              who={<SpeakerLine role={m.role} agentType={row.agentType} authorName={row.authorName} authorAvatar={row.authorAvatar} isOwn={row.isOwn} />}
              userText={m.role === "user"}
              highlight={highlight}
              href={hrefFor(row, m.messageId)}
              onClick={onNavigate}
              onContextMenu={onMatchMenu ? (e) => onMatchMenu(e, m.messageId) : undefined}
            />
          ))}
          {more > 0 && (
            <Link
              href={hrefFor(row, shown[0]?.messageId)}
              onClick={onNavigate}
              className="block px-3 py-1 text-[11px] text-sol-text-dim no-underline hover:text-sol-text-secondary"
            >
              {more} more in this {words.conversation.toLowerCase()}
            </Link>
          )}
        </div>
      )}
    </div>
  );
});
