"use client";

// The tabs a session has open, under its card in the inbox's Browser view
// (store/browserTabsView.ts). A `cast browser` tab raises in the browser that
// holds it (reopens when it is gone), the same actions as the transcript's
// "open tab" pill; a Claude in Chrome tab opens through its clau.de link.

import { useConvex } from "convex/react";
import { AppWindow, Bot, Globe, Sparkles, type LucideIcon } from "lucide-react";
import type { BrowserTabWhere, SessionBrowserTab } from "@codecast/shared/contracts";
import { useBrowserTabActions } from "../../hooks/useBrowserTabActions";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { prefetchBrowserFocusEndpoint } from "../../lib/browserFocus";
import { BrowserTabActionLabel } from "../browser/BrowserTabPill";
import { tabHost } from "../../store/browserTabsView";

const WHERE: Record<BrowserTabWhere, { icon: LucideIcon; name: string }> = {
  chrome: { icon: Globe, name: "Your Chrome" },
  agent: { icon: Bot, name: "Agent browser" },
  pane: { icon: AppWindow, name: "Desktop pane" },
  claude: { icon: Sparkles, name: "Claude in Chrome" },
};

const ROW = "group w-full flex items-center gap-1.5 pl-[26px] pr-2 py-0.5 text-meta text-left min-w-0 hover:bg-sol-bg-highlight/50 transition-colors";

function TabLine({ tab, trailing }: { tab: SessionBrowserTab; trailing?: React.ReactNode }) {
  const { icon: Icon } = WHERE[tab.where];
  return (
    <>
      <Icon className="w-3 h-3 shrink-0 text-sol-text-dim group-hover:text-sol-cyan" aria-label={WHERE[tab.where].name} />
      <span className="truncate text-sol-text-muted group-hover:text-sol-text">{tab.title || tabHost(tab.url) || `tab ${tab.id}`}</span>
      {tab.title && tab.url && <span className="truncate shrink-[2] font-mono text-sol-text-dim">{tabHost(tab.url)}</span>}
      {trailing && <span className="ml-auto shrink-0 font-mono text-sol-text-dim">{trailing}</span>}
    </>
  );
}

function CastTabRow({ tab, sessionUuid }: { tab: SessionBrowserTab; sessionUuid: string | null }) {
  const actions = useBrowserTabActions({ tabId: tab.id, url: tab.url || null }, { sessionUuid });
  const { state } = actions;
  const tone = state.kind === "note" ? "text-sol-red" : state.kind === "busy" ? "text-sol-cyan" : "";
  return (
    <button
      type="button"
      className={`${ROW} ${tone}`}
      title={`${WHERE[tab.where].name}\n${tab.url}`}
      onMouseEnter={actions.check}
      onClick={(e) => {
        e.stopPropagation();
        if (state.kind === "offer") actions.reopen();
        else actions.focus();
      }}
      aria-busy={state.kind === "busy"}
    >
      <TabLine tab={tab} trailing={state.kind === "idle" ? null : <BrowserTabActionLabel state={state} idle={null} />} />
    </button>
  );
}

export function SessionBrowserTabs({ tabs, sessionUuid }: { tabs: SessionBrowserTab[]; sessionUuid: string | null }) {
  const convex = useConvex();
  const hasCast = tabs.some((t) => t.where !== "claude");
  useWatchEffect(() => {
    if (hasCast) prefetchBrowserFocusEndpoint(convex);
  }, [hasCast, convex]);
  return (
    <div className="pb-1" data-browser-tabs>
      {tabs.map((tab) =>
        tab.where === "claude" ? (
          <a
            key={`${tab.where}:${tab.id}`}
            href={`https://clau.de/chrome/tab/${tab.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className={ROW}
            title={`${WHERE.claude.name}${tab.url ? `\n${tab.url}` : ""}`}
            onClick={(e) => e.stopPropagation()}
          >
            <TabLine tab={tab} />
          </a>
        ) : (
          <CastTabRow key={`${tab.where}:${tab.id}`} tab={tab} sessionUuid={sessionUuid} />
        ),
      )}
    </div>
  );
}
