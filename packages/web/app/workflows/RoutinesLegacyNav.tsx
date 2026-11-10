import { cn } from "../../lib/utils";

/** The Workflows page's section bar, kept for Classic and Minimal (Modern puts
 *  the sections in the page header, components/ui/page-header). */
export function RoutinesLegacyNav<K extends string>({ tabs, tab, onTab }: { tabs: { key: K; label: string; icon: any }[]; tab: K; onTab: (key: K) => void }) {
  return (
    <nav className="shrink-0 flex items-center gap-1 px-3 border-b border-sol-border/20 overflow-x-auto cq-no-scrollbar" aria-label="Workflow sections">
      {tabs.map((t) => {
        const Icon = t.icon;
        const active = tab === t.key;
        return (
          <button
            key={t.key}
            type="button"
            data-routines-tab={t.key}
            onClick={() => onTab(t.key)}
            className={cn("relative shrink-0 inline-flex items-center gap-1.5 h-9 px-2.5 text-[12.5px] transition-colors", active ? "font-semibold" : "hover:bg-sol-bg-highlight/60")}
            style={{ color: active ? "var(--sol-text)" : "var(--sol-text-muted)" }}
            aria-current={active ? "page" : undefined}
          >
            <Icon className="w-3.5 h-3.5" style={{ color: active ? "var(--sol-cyan)" : undefined }} />
            {t.label}
            {active && <span className="absolute left-2 right-2 -bottom-px h-[2px] rounded-full" style={{ background: "var(--sol-cyan)" }} />}
          </button>
        );
      })}
    </nav>
  );
}
