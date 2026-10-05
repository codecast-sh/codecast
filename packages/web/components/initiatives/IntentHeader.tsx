"use client";
// The header a goal's page and a project's page both wear
// (docs/architecture/initiatives-projects-role-page.md I5 "Where it shows"):
// a stripe in the page's colour, the way back, a glyph, the title in the serif
// face, the id, share, then one line of chips that says status, who drives it,
// how it is going, when it is due and how far along it is. The two pages are
// one product, so the grammar lives here once: the title that renames in
// place, the chip that opens a list, the chip that sets the target day, the
// tab strip (the scope panel's own: data-scope-tab, an h-8 row, an underline
// under the active one) and the tab that lives in the URL.
import { useCallback, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, CalendarDays, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { FilterOptionList, type FilterOption } from "../FilterDropdown";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { INITIATIVE_ACCENT } from "../../lib/initiativeColors";

export const INTENT_HAIRLINE = "color-mix(in srgb, var(--sol-border) 22%, transparent)";

type DataAttrs = Record<`data-${string}`, string | undefined>;

export function IntentHeader({ stripeColor, stripeClassName, accent = INITIATIVE_ACCENT, back, glyph, title, onRename, renameLabel, titleData, idChip, share, chips, actions, extra, tabs, phone }: {
  /** The stripe's colour as a CSS colour, or as a background class when the colour is one (a project's swatch). */
  stripeColor?: string;
  stripeClassName?: string;
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
  share?: ReactNode;
  /** Line two: status, who drives it, health, target, progress, the numbers, the next milestone. */
  chips: ReactNode;
  /** Controls at the far right of the title row (the goal page's panel toggle). */
  actions?: ReactNode;
  /** Rows under the chip line that belong to this page alone (a project's folder, repositories and charter). */
  extra?: ReactNode;
  /** A tab strip as the header's last row; its underline sits on the header's own border. */
  tabs?: ReactNode;
  phone?: boolean;
}) {
  // The title wraps, so what stands beside it sits on its first line.
  const firstLine = cn("shrink-0 inline-flex items-center", phone ? TITLE_LINE.phone.box : TITLE_LINE.wide.box);
  return (
    <>
      <div
        className={cn("shrink-0 h-[3px] w-full", stripeClassName)}
        style={{ background: stripeColor, maskImage: "linear-gradient(90deg, #000, rgba(0,0,0,.3) 70%, transparent)", WebkitMaskImage: "linear-gradient(90deg, #000, rgba(0,0,0,.3) 70%, transparent)" }}
        aria-hidden
        data-intent-stripe
      />
      <header className={cn("shrink-0 border-b", phone ? "px-3 pt-2" : "px-5 pt-3", !tabs && (phone ? "pb-2.5" : "pb-3"))} style={{ borderColor: INTENT_HAIRLINE }} data-intent-header>
        <div className="flex items-start gap-3">
          <Link href={back.href} className={cn("shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-lg hover:bg-sol-bg-highlight/70", phone ? TITLE_LINE.phone.back : TITLE_LINE.wide.back)} style={{ color: "var(--sol-text-muted)" }} aria-label={back.label}>
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2 min-w-0">
              <span className={firstLine}>{glyph}</span>
              <IntentTitle title={title} onRename={onRename} label={renameLabel} accent={accent} phone={phone} data={titleData} />
              {idChip && <span className={firstLine}>{idChip}</span>}
              {share && <span className={firstLine}>{share}</span>}
            </div>
            <div className={cn("mt-2 flex items-center gap-x-4 gap-y-1.5 flex-wrap", phone ? "text-[12px]" : "text-[12.5px]")} data-intent-chips>
              {chips}
            </div>
            {extra}
            {tabs && <div className="mt-2.5 -ml-2">{tabs}</div>}
          </div>
          {actions}
        </div>
      </header>
    </>
  );
}

/** The id beside a title, in the page's accent. */
export function IntentIdChip({ id, accent = INITIATIVE_ACCENT }: { id: string; accent?: string }) {
  return <span className="shrink-0 whitespace-nowrap inline-flex items-center h-[20px] px-1.5 rounded-md text-[10.5px] font-medium" style={{ background: accent, color: "var(--sol-bg)", fontFamily: "var(--font-mono)" }}>{id}</span>;
}

/** The title's type, the height of one of its lines, and the margin that
 *  centres the 28px back button on that line, by header. */
const TITLE_LINE = {
  wide: { text: "text-[22px] leading-[26px]", box: "h-[26px]", back: "-my-px" },
  phone: { text: "text-[18px] leading-[22px]", box: "h-[22px]", back: "-my-[3px]" },
} as const;

function IntentTitle({ title, onRename, label = "Title", accent, phone, data }: { title: string; onRename?: (next: string) => void; label?: string; accent: string; phone?: boolean; data?: DataAttrs }) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    const next = draft?.trim();
    if (next && next !== title) onRename?.(next);
    setDraft(null);
  };
  const line = phone ? TITLE_LINE.phone : TITLE_LINE.wide;
  if (draft !== null) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setDraft(null); }}
        className={cn("min-w-0 flex-1 bg-transparent outline-none font-semibold tracking-tight border-b", line.text, line.box)}
        style={{ fontFamily: "var(--font-serif)", borderColor: accent }}
        aria-label={label}
      />
    );
  }
  return (
    // The page's own title reads in full: it wraps as far as it needs. Only
    // the phone header holds it to two lines, and there the whole title is
    // its tooltip, which the rename hint never takes the place of.
    <h1
      className={cn("min-w-0 font-semibold tracking-tight [overflow-wrap:anywhere]", line.text, phone && "line-clamp-2", onRename && "cursor-text")}
      style={{ fontFamily: "var(--font-serif)" }}
      onClick={onRename ? () => setDraft(title) : undefined}
      title={phone ? title : onRename ? "Click to rename" : undefined}
      data-intent-title
      {...data}
    >
      {title}
    </h1>
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
  return (
    <div className={cn("shrink-0 flex items-center gap-1", !bare && "border-b pl-1 pr-1.5", className)} style={bare ? undefined : { borderColor: INTENT_HAIRLINE }} data-intent-tabs>
      <nav className="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto cq-no-scrollbar -mb-px" aria-label="Sections">
        {tabs.map((t) => {
          const Icon = t.icon;
          const on = active === t.key;
          return (
            <button
              key={t.key}
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
