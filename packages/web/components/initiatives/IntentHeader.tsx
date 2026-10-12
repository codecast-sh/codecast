"use client";
// A project board's header (cohesive build spec §5.3, D10) and the pickers a
// goal and a project share. The board is where a project's work happens, so
// its header is one row: the way back to the project's sheet, its glyph, its
// name (renamed in place), its id, the chips that say status, lead and the
// goals it serves, and its actions at the right end; then the tab strip. The
// pickers live here once: the chip that opens a list (a goal's owner and
// status on its line and sheet, a project's status), the chip that sets a
// target day, the tab strip in the scope panel's grammar, and the tab that
// lives in the URL.
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, CalendarDays, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { PROJECT_STATUS, PROJECT_STATUS_ORDER, projectStatusOf } from "../../lib/projectStatus";
import { FilterOptionList, type FilterOption } from "../FilterDropdown";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { INITIATIVE_ACCENT } from "../../lib/initiativeColors";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useProjectDeadline, type DeadlineProject } from "../../hooks/useProjectDeadline";
import { TargetDate } from "./InitiativeAtoms";

export const INTENT_HAIRLINE = "color-mix(in srgb, var(--sol-border) 22%, transparent)";

type DataAttrs = Record<`data-${string}`, string | undefined>;

export function IntentHeader({ accent = INITIATIVE_ACCENT, back, glyph, title, onRename, renameLabel, titleData, idChip, chips, actions, tabs, phone }: {
  /** The page's own accent: the rename underline. */
  accent?: string;
  back: { href: string; label: string };
  glyph: ReactNode;
  title: string;
  /** Present when the viewer may rename it: click the title, Enter or blur saves. */
  onRename?: (next: string) => void;
  renameLabel?: string;
  titleData?: DataAttrs;
  idChip?: ReactNode;
  /** Status, who leads it, what it serves: the facts the row carries. */
  chips: ReactNode;
  /** Controls at the row's right end (About, share). */
  actions?: ReactNode;
  /** A tab strip under the row; its underline sits on the header's own border. */
  tabs?: ReactNode;
  phone?: boolean;
}) {
  return (
    <header className="shrink-0 border-b" style={{ borderColor: INTENT_HAIRLINE }} data-intent-header>
      <div className={cn("flex items-center gap-x-2.5 gap-y-1.5 min-w-0", phone ? "flex-wrap px-3 pt-2 pb-1.5" : "px-4 py-2 min-h-[46px]")} data-intent-row>
        <Link href={back.href} className="shrink-0 inline-flex items-center justify-center w-7 h-7 -ml-1 rounded-lg hover:bg-sol-bg-highlight/70" style={{ color: "var(--sol-text-muted)" }} aria-label={back.label} title={back.label} data-intent-back>
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <span className="shrink-0 inline-flex items-center">{glyph}</span>
        <IntentTitle title={title} onRename={onRename} label={renameLabel} accent={accent} phone={phone} data={titleData} />
        {idChip && <span className="shrink-0 inline-flex items-center">{idChip}</span>}
        <div className={cn("flex items-center gap-x-3 gap-y-1 min-w-0 text-[12.5px]", phone ? "order-last basis-full flex-wrap pl-[38px]" : "flex-wrap")} data-intent-chips>
          {chips}
        </div>
        <span className="flex-1" />
        {actions && <span className="shrink-0 inline-flex items-center gap-1.5">{actions}</span>}
      </div>
      {tabs && <div className={phone ? "px-2" : "px-3"}>{tabs}</div>}
    </header>
  );
}

/** The id beside a title, as the sheet shows it: quiet, in the mono face. */
export function IntentIdChip({ id }: { id: string }) {
  return <span className="shrink-0 whitespace-nowrap font-mono text-[11px]" style={{ color: "var(--sol-text-dim)" }} data-intent-id>{id}</span>;
}

function IntentTitle({ title, onRename, label = "Title", accent, phone, data }: { title: string; onRename?: (next: string) => void; label?: string; accent: string; phone?: boolean; data?: DataAttrs }) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    const next = draft?.trim();
    if (next && next !== title) onRename?.(next);
    setDraft(null);
  };
  const text = phone ? "text-[16px] leading-[22px]" : "text-[17px] leading-[24px]";
  if (draft !== null) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setDraft(null); }}
        className={cn("min-w-[12ch] flex-1 bg-transparent outline-none font-medium border-b", text)}
        style={{ fontFamily: "var(--font-serif)", borderColor: accent }}
        aria-label={label}
      />
    );
  }
  return (
    // One row: the name holds one line (two on a phone) and its whole text is
    // the tooltip, which the rename hint never takes the place of.
    <h1
      className={cn("min-w-0 shrink font-medium tracking-[-0.01em]", text, phone ? "line-clamp-2 [overflow-wrap:anywhere]" : "truncate", onRename && "cursor-text")}
      style={{ fontFamily: "var(--font-serif)" }}
      onClick={onRename ? () => setDraft(title) : undefined}
      title={title}
      data-intent-title
      {...data}
    >
      {title}
    </h1>
  );
}

/** A project's status, read and set in place: the one picker its board's
 *  header and its sheet both use. `face` draws the chip when the surface has
 *  its own word for the state (the sheet's live sessions). */
export function ProjectStatusPick({ status, onPick, face, ...data }: { status: string | undefined; onPick: (status: string) => void; face?: ReactNode } & DataAttrs) {
  const options = useMemo(() => PROJECT_STATUS_ORDER.map((key) => {
    const Icon = PROJECT_STATUS[key].icon;
    return { key, label: PROJECT_STATUS[key].label, face: <Icon className={cn("w-3.5 h-3.5", PROJECT_STATUS[key].color)} /> };
  }), []);
  const current = projectStatusOf(status);
  const Icon = current.icon;
  return (
    <IntentPickChip options={options} value={status ?? "active"} width="w-44" onPick={(key) => { if (key && key !== status) onPick(key); }} {...data}>
      {face ?? <>
        <Icon className={cn("w-3.5 h-3.5", current.color)} />
        <span style={{ color: "var(--sol-text-secondary)" }}>{current.label}</span>
      </>}
    </IntentPickChip>
  );
}

/** A chip that opens a list: a header's status and owner both read and write this way. */
export function IntentPickChip({ children, options, value, onPick, width = "w-56", ...data }: { children: ReactNode; options: FilterOption[]; value: string; onPick: (key: string) => void; width?: string } & DataAttrs) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex items-center gap-1.5 -mx-1 px-1 h-6 rounded-md transition-colors hover:bg-sol-bg-highlight/70" {...data}>{children}</button>
      </PopoverTrigger>
      <PopoverContent align="start" className={cn(width, "p-1 max-h-80 overflow-y-auto bg-sol-bg border border-sol-border shadow-xl")}>
        <FilterOptionList options={options} value={value} onChange={onPick} onPicked={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** A day as a date field reports it, or null while it is half typed: the
 *  field hands over a year one digit at a time ("0002", "0020", "0202"). */
const typedDay = (value: string): string | null => (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number(value.slice(0, 4)) >= 1990 ? value : null);

/** The target day, read and set in place: the one control a goal's header and
 *  a project's header both use. A click opens a date field. The day is
 *  written on blur or Enter, never on a keystroke, so a half typed year writes
 *  nothing; Escape leaves it as it was; only Clear removes it. `day` and
 *  `onCommit` speak "YYYY-MM-DD", and each page stores that its own way. */
export function IntentTargetChip({ day, onCommit, onClear, label, emptyLabel, accent = INITIATIVE_ACCENT, children, ...data }: {
  day?: string;
  onCommit: (day: string) => void;
  onClear: () => void;
  /** What the field is, for a screen reader and the tooltip ("Target date"). */
  label: string;
  /** What stands in the chip while no day is set ("No target"). */
  emptyLabel: string;
  accent?: string;
  /** The day as the page draws it (TargetDate); nothing while none is set. */
  children?: ReactNode;
} & DataAttrs) {
  const [editing, setEditing] = useState(false);
  // Enter closes the field, and a browser may then blur it: one close, one write.
  const open = useRef(false);
  const close = (value?: string) => {
    if (!open.current) return;
    open.current = false;
    setEditing(false);
    const next = value === undefined ? null : typedDay(value);
    if (next && next !== day) onCommit(next);
  };
  if (!editing) {
    return (
      <button type="button" onClick={() => { open.current = true; setEditing(true); }} className="inline-flex items-center gap-1.5 -mx-1 px-1 h-6 rounded-md transition-colors hover:bg-sol-bg-highlight/70" title={label} data-intent-target={day ?? ""} {...data}>
        <CalendarDays className="w-3.5 h-3.5" style={{ color: "var(--sol-text-dim)" }} />
        {children ?? <span className="text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>{emptyLabel}</span>}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 h-6" data-intent-target="editing" {...data}>
      <input
        type="date"
        autoFocus
        defaultValue={day ?? ""}
        className="text-[11.5px] bg-transparent outline-none tabular-nums border-b"
        style={{ color: "var(--sol-text)", borderColor: accent }}
        onBlur={(e) => close(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") close(e.currentTarget.value); if (e.key === "Escape") close(); }}
        aria-label={label}
      />
      {day && (
        // mousedown would blur the field and write the day it holds before the click lands
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { close(); onClear(); }} className="text-[10.5px] transition-colors hover:text-sol-red" style={{ color: "var(--sol-text-dim)" }} data-intent-target-clear>
          Clear
        </button>
      )}
    </span>
  );
}

/** The project's deadline chip: "No deadline" until one is set, the day (red
 *  once passed) after. The board's header and the project sheet's head both draw it. */
export function ProjectDeadlineChip({ project, now, ...data }: { project: DeadlineProject; now: number } & DataAttrs) {
  const { day, onCommit, onClear } = useProjectDeadline(project);
  return (
    <IntentTargetChip day={day} label="Project deadline" emptyLabel="No deadline" accent="var(--sol-cyan)" onCommit={onCommit} onClear={onClear} {...data}>
      {project.target_date ? <TargetDate ts={project.target_date} now={now} done={project.status === "done"} local /> : null}
    </IntentTargetChip>
  );
}

export type IntentTab<K extends string = string> = { key: K; label: string; icon?: LucideIcon; count?: number };

/** The tab strip, in the scope panel's grammar (components/org/scope/ScopePanel). */
export function IntentTabs<K extends string>({ tabs, active, onTab, accent = INITIATIVE_ACCENT, trailing, bare, className }: {
  tabs: readonly IntentTab<K>[];
  active: K;
  onTab: (next: K) => void;
  accent?: string;
  /** A control at the strip's right end (a panel's close button). */
  trailing?: ReactNode;
  /** No rule of its own: the strip sits on a border its parent already draws. */
  bare?: boolean;
  className?: string;
}) {
  // A strip wider than a phone keeps the active tab in view, so a tab opened
  // by a link (?tab=line) is never scrolled off the end.
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useWatchEffect(() => {
    const strip = activeRef.current?.parentElement;
    if (!strip) return;
    const reveal = () => {
      const el = activeRef.current;
      if (!el || strip.scrollWidth <= strip.clientWidth) return;
      const r = el.getBoundingClientRect();
      const box = strip.getBoundingClientRect();
      if (r.right > box.right) strip.scrollLeft += r.right - box.right + 8;
      else if (r.left < box.left) strip.scrollLeft -= box.left - r.left + 8;
    };
    reveal();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(reveal);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [active]);
  return (
    <div className={cn("shrink-0 flex items-center gap-1", !bare && "border-b pl-1 pr-1.5", className)} style={bare ? undefined : { borderColor: INTENT_HAIRLINE }} data-intent-tabs>
      <nav className="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto cq-no-scrollbar -mb-px" aria-label="Sections">
        {tabs.map((t) => {
          const Icon = t.icon;
          const on = active === t.key;
          return (
            <button
              key={t.key}
              ref={on ? activeRef : undefined}
              type="button"
              onClick={() => onTab(t.key)}
              data-scope-tab={t.key}
              className={cn("relative shrink-0 inline-flex items-center gap-1.5 h-8 px-2 text-[12px] transition-colors rounded-t-md", on ? "font-semibold" : "hover:bg-sol-bg-highlight/60")}
              style={{ color: on ? "var(--sol-text)" : "var(--sol-text-muted)" }}
              aria-current={on ? "page" : undefined}
            >
              {Icon && <Icon className="w-3.5 h-3.5" style={{ color: on ? accent : undefined }} />}
              <span>{t.label}</span>
              {t.count ? <span className="text-[10.5px] font-normal tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{t.count}</span> : null}
              {on && <span className="absolute left-1.5 right-1.5 -bottom-px h-[2px] rounded-full" style={{ background: accent }} />}
            </button>
          );
        })}
      </nav>
      {trailing}
    </div>
  );
}

/** A page's tab, kept in the URL (?tab=) so a tab stays linkable. The first
 *  key is the one the bare address opens on. */
export function useIntentTab<K extends string>(keys: readonly K[], base: string): { tab: K; linked: boolean; setTab: (next: K) => void } {
  const router = useRouter();
  const searchParams = useSearchParams();
  const param = searchParams.get("tab");
  const tab = keys.find((k) => k === param) ?? keys[0];
  const setTab = useCallback((next: K) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === keys[0]) params.delete("tab"); else params.set("tab", next);
    const qs = params.toString();
    router.replace(qs ? `${base}?${qs}` : base);
  }, [searchParams, router, base, keys]);
  return { tab, linked: tab !== keys[0], setTab };
}
