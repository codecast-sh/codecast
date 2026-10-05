"use client";

import type { ReactNode } from "react";
import { LogoMark } from "@/components/Logo";
import { CAST_RED, ChromeTab, Favicon, GroupChip, Lights } from "./kit";

/** The human's own tabs, which every mock on the page leaves alone. */
export const HUMAN_TABS = [
  { title: "Inbox (3)", fav: <Favicon color="#d93025" glyph="M" /> },
  { title: "Q4 roadmap", fav: <Favicon color="#1a73e8" glyph="D" /> },
  { title: "Fix order totals #482", fav: <Favicon color="#24292f" glyph="⌥" /> },
];

export type CastTab = { title: string; fav?: ReactNode; loading?: boolean; active?: boolean };

/**
 * A Chrome window: tab strip with the human's tabs, the red "Cast" group the
 * extension owns, the omnibox, and a viewport. Faithful to Chrome's layout,
 * drawn in its light theme so the Solarized page around it reads as "the web".
 */
export function ChromeWindow({
  castTabs,
  url,
  children,
  humanActive = -1,
  showGroup = true,
  loading = false,
  className = "",
  viewportClassName = "",
  compact = false,
}: {
  castTabs: CastTab[];
  url: string;
  children: ReactNode;
  /** Which human tab is in front; -1 means a Cast tab is shown. */
  humanActive?: number;
  showGroup?: boolean;
  loading?: boolean;
  className?: string;
  viewportClassName?: string;
  compact?: boolean;
}) {
  return (
    <div className={`overflow-hidden rounded-[12px] shadow-[0_30px_70px_-30px_rgba(0,43,54,.45),0_0_0_1px_rgba(0,43,54,.12)] flex flex-col ${className}`} style={{ backgroundColor: "#dfe3e8" }}>
      {/* Tab strip */}
      <div className="flex items-end gap-0.5 pl-3 pr-2 pt-2 min-w-0">
        <span className="self-center pb-1 pr-2"><Lights size={10} /></span>
        <div className="flex items-end min-w-0 flex-1 overflow-hidden">
          {HUMAN_TABS.map((t, i) => (
            <span key={t.title} className={compact && i > 0 ? "hidden sm:flex" : "flex"}>
              <ChromeTab title={t.title} fav={t.fav} active={humanActive === i} width={compact ? 130 : 150} />
            </span>
          ))}
          {showGroup && (
            <span className="bx-pop flex items-end min-w-0 ml-1">
              <span className="self-center mb-1 mr-1"><GroupChip label="Cast" size="sm" /></span>
              {castTabs.map((t, i) => (
                <ChromeTab
                  key={i}
                  title={t.title}
                  fav={t.loading ? <span className="bx-spin h-[12px] w-[12px] shrink-0 rounded-full border-[1.5px] border-[#c9ced4] border-t-[#5f6368]" /> : (t.fav ?? <Favicon color="#1d2733" glyph="a" />)}
                  active={!!t.active}
                  groupColor={CAST_RED}
                  badge
                  width={compact ? 150 : 172}
                />
              ))}
            </span>
          )}
        </div>
      </div>
      {/* Toolbar + omnibox */}
      <div className="flex items-center gap-2 px-3 h-10 bg-white border-b border-[#e3e6ea]">
        <span className="flex gap-2.5 text-[#5f6368] shrink-0">
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M15 18l-6-6 6-6" /></svg>
          <svg className="h-4 w-4 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M9 18l6-6-6-6" /></svg>
          <svg className="h-4 w-4 hidden sm:block" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7" /></svg>
        </span>
        <span className="flex-1 min-w-0 flex items-center gap-2 h-7 rounded-full px-3 text-[12px] font-sans" style={{ backgroundColor: "#eef1f4", color: "#1f1f1f" }}>
          <svg className="h-3 w-3 shrink-0 text-[#5f6368]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" /></svg>
          <span className="truncate">{url}</span>
        </span>
        {/* The extension's toolbar icon wears the red badge while cast drives the tab. */}
        <span className="relative shrink-0" title="cast is driving this tab">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-md [--logo-c:#444444]" style={{ backgroundColor: "#fdf6e3" }}><LogoMark size={16} /></span>
          {showGroup && <span className="absolute -right-2 -bottom-1.5 rounded-[3px] px-[2px] text-[6.5px] font-bold leading-[9px] text-white font-sans" style={{ backgroundColor: CAST_RED }}>CAST</span>}
        </span>
      </div>
      {/* Viewport */}
      <div className={`relative flex-1 min-h-0 bg-white ${viewportClassName}`}>
        {loading && <span className="bx-load absolute left-0 right-0 top-0 h-[2px] z-10" style={{ backgroundColor: "#1a73e8" }} />}
        {children}
      </div>
    </div>
  );
}
