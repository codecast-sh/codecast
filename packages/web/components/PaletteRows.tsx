import { FolderGit2, Map as MapIcon, Clock, Waypoints, Cpu, Link as LinkIcon, ListTodo } from "lucide-react";
import type { ReactNode } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { SessionGlyph, SessionIdentityLine } from "./identity";
import { identityRowOf } from "../lib/sessionIdentity";
import { cleanTitle } from "../lib/conversationProcessor";
import { AvatarImg } from "../lib/avatarCache";
import { getProjectName } from "../store/inboxStore";
import { getLabelColor } from "../lib/labelColors";
import { itemClass } from "./paletteStyles";
import { ShortId } from "./ShortId";
import { formatDateSmart } from "@codecast/shared/time";

// Presentational rows of the Cmd+K palette. CommandPalette owns the data and
// the select handlers; these draw a row from plain props, so the marketing
// hero renders the same rows from fixtures.

export function NavIcon({ type, className }: { type: string; className?: string }) {
  const c = className || "w-4 h-4";
  switch (type) {
    case "grid":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" /></svg>;
    case "check":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>;
    case "file":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>;
    case "user":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>;
    case "users":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /></svg>;
    case "inbox":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" /></svg>;
    case "search":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>;
    case "settings":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>;
    case "bell":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>;
    case "star":
      return <svg className={c} fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" /></svg>;
    case "bookmark":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" /></svg>;
    case "session":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>;
    case "code":
      return <FolderGit2 className={className} />;
    case "folder":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>;
    case "message":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 10h8M8 14h5M21 12a8 8 0 01-8 8H7l-4 3v-4.5A8 8 0 0113 4a8 8 0 018 8z" /></svg>;
    case "map":
      return <MapIcon className={c} />;
    case "phone":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>;
    case "clock":
      return <Clock className={c} />;
    case "workflow":
      return <Waypoints className={c} />;
    case "cpu":
      return <Cpu className={c} />;
    case "link":
      return <LinkIcon className={c} />;
    default:
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" strokeWidth={1.5} /></svg>;
  }
}

/** A teammate's avatar with initials behind it, else the session mark. */
function authorGlyph(showAuthor: boolean, authorName?: string, authorAvatar?: string | null): ReactNode {
  return showAuthor ? (
    <AvatarImg
      src={authorAvatar}
      alt={authorName}
      className="w-4 h-4 rounded-full flex-shrink-0"
      fallback={
        <div className="w-4 h-4 rounded-full flex-shrink-0 bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center text-[8px] font-medium text-sol-text-muted">
          {(authorName || "?").split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}
        </div>
      }
    />
  ) : (
    <span className="text-sol-text-dim flex-shrink-0">
      <NavIcon type="session" />
    </span>
  );
}

export type PaletteSessionRowConv = {
  _id: string;
  title?: string;
  short_id?: string;
  project_path?: string;
  git_root?: string;
  updated_at: number;
  isOwn?: boolean;
  authorName?: string;
  authorAvatar?: string | null;
  [key: string]: unknown;
};

/** A "Recent Sessions" row: face, identity line, label, project, author, age. */
export function PaletteSessionRow({ conv, bucket, onSelect }: {
  conv: PaletteSessionRowConv;
  bucket: { name: string } | null;
  onSelect: () => void;
}) {
  const isTeam = conv.isOwn === false;
  const project = getProjectName(conv.git_root, conv.project_path);
  return (
    <CommandPrimitive.Item
      data-palette-type="session" data-palette-id={conv._id} data-palette-title={conv.title} data-palette-short-id={conv.short_id}
      value={`__recent__ ${cleanTitle(conv.title || "")} ${conv.project_path || ""} ${conv.authorName || ""}|||${conv._id}`}
      onSelect={onSelect}
      className={`${itemClass} group`}
    >
      {/* Who the session is (session-characters.md S3): its face,
          else the mark this row always had. */}
      <SessionGlyph
        row={identityRowOf(conv)}
        className="flex-shrink-0"
        fallback={authorGlyph(isTeam && !!(conv.authorAvatar || conv.authorName), conv.authorName, conv.authorAvatar)}
      />
      <SessionIdentityLine row={identityRowOf(conv)} title={cleanTitle(conv.title || "Untitled")} className="flex-1" />
      {bucket && (() => {
        const bc = getLabelColor(bucket.name);
        return (
          <span className={`flex-shrink-0 px-1.5 py-0.5 rounded-full text-[10px] flex items-center gap-1 max-w-[120px] ${bc.bg} ${bc.text}`}>
            <span className={`w-1.5 h-1.5 rounded-[2px] flex-shrink-0 ${bc.dot}`} />
            <span className="truncate">{bucket.name}</span>
          </span>
        );
      })()}
      {project !== "unknown" && (
        <span className="flex-shrink-0 flex items-center gap-1 text-[10px] text-sol-text-dim max-w-[120px]" title={conv.git_root || conv.project_path || project}>
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 opacity-60 ${getLabelColor(project).dot}`} />
          <span className="truncate">{project}</span>
        </span>
      )}
      {isTeam && conv.authorName && (
        <span className="text-[10px] text-sol-text-dim flex-shrink-0">· {conv.authorName}</span>
      )}
      <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{formatDateSmart(conv.updated_at)}</span>
    </CommandPrimitive.Item>
  );
}

export type PaletteSearchResult = {
  conversationId: string;
  title: string;
  updatedAt: number;
  isOwn?: boolean;
  authorName?: string;
  authorAvatar?: string | null;
  titleMatch?: boolean;
  matches?: { content?: string; messageId?: string }[];
  identity?: Record<string, unknown>;
  [key: string]: unknown;
};

/** A "Search Results" row: face, identity line, author, first match, match count, age. */
export function PaletteSearchResultRow({ result, onSelect }: {
  result: PaletteSearchResult;
  onSelect: () => void;
}) {
  const row = identityRowOf({ _id: result.conversationId, title: result.title, ...(result.identity ?? {}) });
  return (
    <CommandPrimitive.Item
      data-palette-type="session" data-palette-id={result.conversationId} data-palette-title={result.title}
      value={`__search__ ${result.title} ${result.matches?.[0]?.content?.slice(0, 100) || ""}|||${result.conversationId}`}
      onSelect={onSelect}
      className={itemClass}
    >
      <SessionGlyph
        row={row}
        className="flex-shrink-0"
        fallback={authorGlyph(!result.isOwn && !!(result.authorAvatar || result.authorName), result.authorName, result.authorAvatar)}
      />
      <div className="flex-1 min-w-0">
        <div className="truncate text-sm flex items-center gap-1.5">
          <SessionIdentityLine row={row} title={cleanTitle(result.title || "Untitled")} />
          {!result.isOwn && (
            <span className="text-[10px] text-sol-text-dim flex-shrink-0">· {result.authorName}</span>
          )}
        </div>
        {result.matches?.[0]?.content && (
          <div className="truncate text-[11px] text-sol-text-dim mt-0.5">
            {result.matches[0].content.slice(0, 80)}
          </div>
        )}
      </div>
      <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">
        {result.titleMatch
          ? "title"
          : result.matches?.length
          ? `${result.matches.length} match${result.matches.length !== 1 ? "es" : ""}`
          // An operator-only query (file:, pr:, ...) matches the session, not a message.
          : "filter"}
      </span>
      <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{formatDateSmart(result.updatedAt)}</span>
    </CommandPrimitive.Item>
  );
}

/** The palette's top bar: the search glyph, the field (children) and what
 *  trails it (the Esc keycap). */
export function PaletteSearchBar({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-sol-border/60">
      <div className="text-sol-text-dim">
        <NavIcon type="search" className="w-[18px] h-[18px]" />
      </div>
      {children}
      {trailing}
    </div>
  );
}

export type PaletteTaskRowTask = { _id: string; title?: string; short_id?: string; updated_at: number; [key: string]: unknown };

/** A "Tasks" row: the task glyph, title, status, short id, age. */
export function PaletteTaskRow({ task, status, onSelect }: {
  task: PaletteTaskRowTask;
  status: { label: string; color: string } | undefined;
  onSelect: () => void;
}) {
  return (
    <CommandPrimitive.Item
    data-palette-type="task" data-palette-id={task._id} data-palette-title={task.title} data-palette-short-id={task.short_id}
      value={`__entity__ ${task.title} ${task.short_id}|||${task._id}`}
      onSelect={onSelect}
      className={itemClass}
    >
      <ListTodo className="w-4 h-4 flex-shrink-0 text-sol-cyan" />
      <span className="truncate flex-1">{task.title || "Untitled"}</span>
      {status && <span className={`text-[10px] flex-shrink-0 ${status.color}`}>{status.label}</span>}
      <ShortId id={task.short_id} className="text-[10px] text-sol-text-dim tabular-nums" />
      <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{formatDateSmart(task.updated_at)}</span>
    </CommandPrimitive.Item>
  );
}
