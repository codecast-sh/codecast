import { useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useTitlebarHead } from "../hooks/useTitlebarHead";
import { useIsModernStyle } from "../hooks/useVisualStyle";
import { SyncProgressBadge } from "./SyncProgressBadge";
import { PageHeader } from "./ui/page-header";
import { activeTabOf, tabSelectionSummary } from "./listTabSelection";
import type { ListTab } from "./GenericListView";
import { modernButton, modernLook, modernMenuRow, modernPopover, modernTab, modernTabList } from "./ui/modernLook";

const M_TRIGGER = modernButton({ variant: "outline", size: "sm" });

// GenericListView's header. In the Modern style, on a page of its own (Tasks,
// Docs, Decisions), it is the shared page header: the page's name, the status
// tabs after it, the toolbar on the right, and the chip filter bar as its
// second row. In Classic and Minimal, and drawn as one pane of another page
// (the line's For you) in any style, it is the list's own bar, the name for
// screen readers only.
//
// Both are query containers: the tabs fold into a dropdown (.cq-tabs-compact),
// the toolbar sheds its labels (.cq-header-collapse) and the filter bar
// compacts (.cq-filter-bar) off the header's own width (globals.css).

/** Compact stand-in for the preset pill row, shown when the header is too narrow
 *  to fit every pill (see .cq-tabs-compact). Surfaces the active preset + count
 *  and drops the list into a popover so no preset is ever out of reach. */
function TabDropdown({
  tabs,
  activeTab,
  onChange,
}: {
  tabs: ListTab[];
  activeTab: string;
  onChange: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = activeTabOf(tabs, activeTab);
  const summary = tabSelectionSummary(tabs, activeTab);

  useWatchEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    // Esc closes the popover, and only the popover (captured before the
    // list's own Esc and the detail's close).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopPropagation(); setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", handler); document.removeEventListener("keydown", onKey, true); };
  }, [open]);

  // The label/count only collapse when there's an icon to stand in for them, so
  // icon-less consumers (e.g. Docs) keep their text at every width.
  const labelCollapse = summary.icons.length ? "cq-tab-label" : "";

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 h-7 px-2 rounded-md bg-sol-bg-alt border border-sol-border/40 text-xs text-sol-text hover:border-sol-border transition-colors ${M_TRIGGER}`}
        title={summary.label}
      >
        {summary.icons.length > 0 && (
          <span className="flex items-center -space-x-0.5 flex-shrink-0">
            {summary.icons.slice(0, 4).map((I, i) => <I key={i} className="w-3.5 h-3.5 flex-shrink-0 text-sol-text-muted" />)}
          </span>
        )}
        <span className={`font-medium whitespace-nowrap max-w-[14rem] truncate ${labelCollapse}`}>{summary.label}</span>
        {summary.count != null && summary.count > 0 && (
          <span className={`text-meta tabular-nums text-sol-text-dim ${labelCollapse}`}>{summary.count}</span>
        )}
        <ChevronDown className="w-3 h-3 opacity-60 flex-shrink-0 cq-caret" />
      </button>
      {open && (
        <div className={`absolute top-full left-0 mt-1 w-52 max-h-[min(70vh,28rem)] overflow-y-auto bg-sol-bg border border-sol-border rounded-lg shadow-xl z-[250] py-1 ${modernLook(modernPopover, "modern:p-1")}`}>
          {tabs.map((t) => {
            const TIcon = t.icon;
            const isActive = active?.key === t.key;
            return (
              <button
                key={t.key}
                onClick={() => { onChange(t.key); setOpen(false); }}
                title={t.title ?? t.label}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                  isActive ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt"
                } ${modernMenuRow({ selected: isActive })}`}
              >
                {TIcon && <TIcon className="w-3.5 h-3.5 flex-shrink-0 text-sol-text-dim" />}
                <span className="flex-1 text-left whitespace-nowrap">{t.label}</span>
                {t.count != null && t.count > 0 && (
                  <span className="text-meta tabular-nums text-sol-text-dim">{t.count}</span>
                )}
                {isActive && <Check className="w-3 h-3 text-sol-cyan flex-shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The status tabs: a segmented pill row while there is room, one compact
 *  dropdown once the header is too tight (≤1235px, .cq-tabs-compact). */
function ListTabs({ tabs, activeTab, onChange }: { tabs: ListTab[]; activeTab: string; onChange: (key: string) => void }) {
  if (tabs.length < 2) return null;
  const activeKey = activeTabOf(tabs, activeTab)?.key ?? null;
  return (
    <>
      <div data-list-tabs className={`cq-tabs-pills flex items-center gap-0.5 p-0.5 rounded-lg bg-sol-bg-alt/40 border border-sol-border/30 flex-wrap ${modernTabList}`}>
        {tabs.map((tab) => {
          const isActive = activeKey === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => onChange(tab.key)}
              title={tab.title}
              className={`text-xs px-2.5 h-6 rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap flex-shrink-0 ${
                isActive
                  ? "bg-sol-bg-highlight text-sol-text shadow-sm"
                  : "text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt/60"
              } ${modernTab({ active: isActive })}`}
            >
              {tab.label}
              {tab.count != null && tab.count > 0 && <span className="text-meta tabular-nums opacity-60">{tab.count}</span>}
            </button>
          );
        })}
      </div>
      <div className="cq-tabs-compact">
        <TabDropdown tabs={tabs} activeTab={activeTab} onChange={onChange} />
      </div>
    </>
  );
}

export interface ListViewHeaderProps {
  /** The list is the page (Modern: a visible title in the shared page header), not one pane of another page. */
  page: boolean;
  title: string;
  syncScope?: string;
  tabs: ListTab[];
  activeTab: string;
  onTabChange: (key: string) => void;
  /** The right-hand toolbar: search, filter, display, palette, create. */
  toolbar: ReactNode;
  /** The chip filter bar, when a filter is set. */
  children?: ReactNode;
}

export function ListViewHeader(props: ListViewHeaderProps) {
  const modern = useIsModernStyle();
  return props.page && modern ? <ListPageHeader {...props} /> : <ListPaneHeader {...props} />;
}

function ListPageHeader({ title, syncScope, tabs, activeTab, onTabChange, toolbar, children }: ListViewHeaderProps) {
  return (
    <PageHeader
      legacy={null}
      title={title}
      tabs={<>
        {syncScope && <SyncProgressBadge scope={syncScope} />}
        <ListTabs tabs={tabs} activeTab={activeTab} onChange={onTabChange} />
      </>}
      actions={<div data-list-toolbar className="cq-header-toolbar flex flex-wrap items-center justify-end gap-1.5">{toolbar}</div>}
    >
      {children ? <div className="cq-filter-bar flex w-full items-center flex-wrap gap-x-1.5 gap-y-1.5">{children}</div> : null}
    </PageHeader>
  );
}

function ListPaneHeader({ title, syncScope, tabs, activeTab, onTabChange, toolbar, children }: ListViewHeaderProps) {
  const titlebarRef = useTitlebarHead<HTMLDivElement>();
  // The outer wrapper is the container-query context; the inner .cq-header row
  // is what adapts (wraps the toolbar below the tabs) as the panel narrows. The
  // header's own rule (.cc-panel__head) is the one line under it; a shown filter
  // bar draws its own top rule.
  return (
    <div className="cq-container">
      <div ref={titlebarRef} className="cq-header cq-header-pad cc-panel__head cc-panel__head--flow flex-wrap justify-between gap-x-2">
        <div className="flex items-center gap-2 min-w-0">
          {/* The header keeps the page's name for screen readers only. */}
          <h1 className="sr-only">{title}</h1>
          {syncScope && <SyncProgressBadge scope={syncScope} />}
          <ListTabs tabs={tabs} activeTab={activeTab} onChange={onTabChange} />
        </div>
        <div data-list-toolbar className="cq-header-toolbar flex flex-wrap items-center justify-end gap-1.5 ml-auto">{toolbar}</div>
      </div>
      {children ? (
        <div className="cq-header-pad cq-filter-bar flex items-center flex-wrap gap-x-1.5 gap-y-1.5 px-6 py-2 border-t border-sol-border/30 bg-sol-bg-alt/20">{children}</div>
      ) : null}
    </div>
  );
}
