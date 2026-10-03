import type { MouseEvent } from "react";
import { highlightMatch, getSnippet } from "../../lib/searchHighlight";
import type { SessionSearchRow } from "../../lib/instantSessionSearch";
import { SessionGlyph } from "../identity";
import { formatSearchTimestamp } from "../../lib/searchTimestamp";
import { SearchOrigin } from "./SearchOrigin";

/** One session in the top bar's search results: its face, title and counts,
 *  then up to three matched messages with the query highlighted. */
export function SearchResultRow({ session, query, selected, onClick, onContextMenu }: {
  session: SessionSearchRow;
  query: string;
  selected: boolean;
  onClick?: () => void;
  onContextMenu?: (e: MouseEvent) => void;
}) {
  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`w-full text-left mx-1 rounded-lg transition-colors ${
        selected
          ? "bg-amber-200/60 dark:bg-amber-900/40"
          : "hover:bg-amber-100/30 dark:hover:bg-amber-900/20"
      }`}
    >
      <div className="px-3 py-2 flex items-center gap-2">
        {/* Who the session is (session-characters.md S3). */}
        <SessionGlyph row={session.identity} className="flex-shrink-0" />
        <span className="text-sm font-semibold text-sol-text truncate max-w-[600px]">
          {session.title}
        </span>
        {!session.isOwn && (
          <span className="text-[10px] text-sol-text-dim px-1.5 py-0.5 bg-sol-bg rounded border border-sol-border">
            {session.authorName}
          </span>
        )}
        <span className="text-[10px] text-sol-text-dim px-1.5 py-0.5 bg-sol-bg rounded">
          {session.messageCount} msgs
        </span>
        <span className="text-[10px] text-sol-text-dim ml-auto whitespace-nowrap">
          {formatSearchTimestamp(session.updatedAt)}
        </span>
      </div>
      <div className={`ml-4 space-y-1 border-l-2 border-sol-border/40 pl-3 ${session.matches.length || session.instantSnippet || session.origin || session.workerCount ? "pb-2" : ""}`}>
        <SearchOrigin row={session} query={query} className="px-2 pt-0.5" />
        {/* No message hits yet (or ever): show where the name
            match landed rather than a bare header row. When the
            content tier lands, its snippets replace this. */}
        {session.matches.length === 0 && session.instantSnippet && (
          <p className="px-2 py-1 text-xs text-sol-text-dim leading-relaxed line-clamp-2">
            {highlightMatch(getSnippet(session.instantSnippet, query, 180), query)}
          </p>
        )}
        {session.matches.slice(0, 3).map((match, matchIndex) => (
          <div
            key={`${session.conversationId}-${matchIndex}`}
            className="px-2 py-1"
          >
            <div className="flex items-center gap-2 mb-0.5">
              <span
                className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                  match.role === "user"
                    ? "bg-blue-500/20 text-blue-700 dark:text-blue-300"
                    : "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
                }`}
              >
                {match.role}
              </span>
              <span className="text-[10px] text-sol-text-dim">
                {formatSearchTimestamp(match.timestamp)}
              </span>
            </div>
            <p className="text-sm text-sol-text-secondary leading-relaxed line-clamp-3">
              {highlightMatch(getSnippet(match.content, query), query)}
            </p>
          </div>
        ))}
      </div>
    </button>
  );
}
