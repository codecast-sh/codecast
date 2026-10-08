"use client";
// One frame for every sheet (cohesive build spec §5.1, D4, D13): the bar
// with Back (only when a sheet lies under this one) and the crumb (where the
// object sits in the company, each step its own sheet), then the head in the
// same order on every kind: the name, Talk to whoever answers for it, the
// menu; the facts line (owner · state · measure · date); what it serves; the
// Ask box. The kind's own sections follow as children, built from
// SheetSection and SheetFolds so the four sheets read as siblings.
import { Fragment, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, Ellipsis, MessageSquare, X } from "lucide-react";
import { objectHref, type OrgObjectKind } from "@codecast/shared/entities";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { copyText } from "../../../lib/copyText";
import { cn } from "../../../lib/utils";
import { KeyCap } from "../../KeyboardShortcutsHelp";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../ui/tooltip";
import { SectionHead } from "../../initiatives/InitiativeRecord";
import { ORG_BAND, ORG_RULE } from "../orgFrame";
import { isPlainClick } from "./orgOpenContext";
import { useSheetHost } from "./sheetHost";
import { AskBox } from "./AskBox";
import type { Seat } from "./objects";

export type Named = { kind: OrgObjectKind; ref: string; title: string };
export type SheetFacts = { owner?: ReactNode; state?: ReactNode; measure?: ReactNode; date?: ReactNode };
export type SheetMenuItem = { label: string; onSelect: () => void; danger?: boolean };

const RULE = "var(--cc-panel-rule, color-mix(in srgb, var(--sol-border) 45%, transparent))";
const DIM = "var(--sol-text-dim)";
/** The one side gutter of a sheet, bar and body alike: the crumb, the glyph
 *  and the facts share one left edge, the close and the menu one right edge. */
const SHEET_GUTTER = "px-[22px]";

/** A name in the frame that opens its own sheet; a plain click stays in the screen. */
export function ObjectLink({ n, className, children }: { n: Named; className?: string; children?: ReactNode }) {
  const host = useSheetHost();
  return (
    <Link
      href={objectHref(n.kind, n.ref)}
      onClick={(e) => { if (!host || !isPlainClick(e)) return; e.preventDefault(); host.open(n.kind, n.ref); }}
      className={cn("min-w-0 truncate no-underline hover:underline underline-offset-[3px]", className)}
      data-sheet-link={n.ref}
    >
      {children ?? n.title}
    </Link>
  );
}

export function SheetFrame({ kind, idRef, idLabel, linkRef, glyph, title, onRename, crumbs, facts, serves, talk, ask, actions, menu = [], children, loading }: {
  kind: OrgObjectKind;
  /** The object's own short ref, shown beside its name. */
  idRef?: string | null;
  /** What the head shows beside the name when it says more than the id (a role's "@handle · or-7"). Defaults to idRef. */
  idLabel?: string | null;
  /** The ref its address takes, for Copy link, when it is not shown (a person's handle). Defaults to idRef. */
  linkRef?: string | null;
  glyph: ReactNode;
  title: string;
  /** The name is editable where the object's owner may rename it. */
  onRename?: (title: string) => void;
  /** Where it sits: the workspace, then each object above it. The workspace closes the sheets. */
  crumbs: Named[];
  facts?: SheetFacts;
  serves?: Named[];
  /** Who answers for it: "Talk to …" puts them on the left (D5c). */
  talk?: Seat | null;
  /** The Ask box (D6), or Message for a person. */
  ask?: { seat: Seat } | { person: { userId: string; name: string } } | null;
  /** The kind's own buttons in the head, before Talk (a person's Call). */
  actions?: ReactNode;
  menu?: SheetMenuItem[];
  children?: ReactNode;
  /** The object has not arrived in the store yet. */
  loading?: boolean;
}) {
  const host = useSheetHost();
  const cells = facts ? [facts.owner, facts.state, facts.measure, facts.date].filter((c) => c != null && c !== false) : [];
  const leftIs = (seat: Seat | null | undefined) => !!seat && !!host && host.leftConversationId === seat.conversationId;
  const showTalk = !!talk && !!host?.talkable && !leftIs(talk);
  const askSeat = ask && "seat" in ask ? ask.seat : null;
  const showAsk = !!ask && !(askSeat && leftIs(askSeat));
  const addressRef = linkRef ?? idRef;
  const link = addressRef ? objectHref(kind, addressRef) : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-sheet={kind} data-sheet-ref={idRef ?? ""}>
      {/* The screen's band and rule, so this rule meets the conversation head's across the seam. */}
      <div className={cn("flex shrink-0 items-center gap-2 border-b text-[12px]", ORG_BAND, SHEET_GUTTER)} style={{ borderColor: ORG_RULE, color: "var(--sol-text-muted)" }} data-sheet-bar>
        {host?.under && (
          <>
            <button type="button" onClick={host.back} className="inline-flex min-w-0 max-w-[45%] items-center gap-1 hover:underline underline-offset-[3px]" style={{ color: "var(--sol-text-secondary)" }} title={host.underTitle ? `Back to ${host.underTitle}` : "Back to the sheet before"} aria-label={host.underTitle ? `Back to ${host.underTitle}` : "Back"} data-sheet-back>
              <ArrowLeft className="h-3.5 w-3.5 shrink-0" />
              {/* The crumb beside it already names the step under this one when it is the parent. */}
              {host.underTitle && host.underTitle !== crumbs[crumbs.length - 1]?.title && <span className="truncate">{host.underTitle}</span>}
            </button>
            {crumbs.length > 0 && <span aria-hidden style={{ color: DIM }}>|</span>}
          </>
        )}
        <nav className="flex min-w-0 items-center gap-[5px] overflow-hidden whitespace-nowrap" aria-label="Where it sits" data-sheet-crumb>
          {crumbs.map((c, i) => (
            <Fragment key={`${c.kind}:${c.ref}:${i}`}>
              {i > 0 && <span aria-hidden style={{ color: DIM }}>›</span>}
              {i === 0 && !c.ref
                ? <button type="button" onClick={host?.close} className="shrink-0 hover:text-[var(--sol-text)]" data-sheet-crumb-workspace>{c.title}</button>
                : <ObjectLink n={c} className="hover:!text-[var(--sol-text)]" />}
            </Fragment>
          ))}
        </nav>
        {host && (
          <span className="ml-auto inline-flex shrink-0 items-center" style={{ color: DIM }}>
            <TooltipProvider delayDuration={400}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" onClick={host.close} className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-sol-bg-highlight/70" aria-label={host.covers ? "Back to the company" : "Close"} data-sheet-close>
                  <X className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="flex items-center gap-1.5">Close <KeyCap size="xs">Esc</KeyCap> steps back</TooltipContent>
            </Tooltip>
            </TooltipProvider>
          </span>
        )}
      </div>

      <div className={cn("org-sheet-body min-h-0 flex-1 overflow-y-auto pb-8 pt-[18px] [container-type:inline-size]", SHEET_GUTTER)} data-sheet-body>
        <div className="flex items-start gap-2.5">
          {/* Centred on the title's first line box (22px at 1.2 leading), so a diamond, a face and an avatar all sit on its optical middle. */}
          <span className="inline-flex h-[26px] w-5 shrink-0 items-center justify-center" aria-hidden>{glyph}</span>
          <div className="min-w-0 flex-1">
            <SheetTitle title={title} onRename={onRename} focus={!!host?.focusTitle} onSettled={host?.titleSettled} />
          </div>
          {(idLabel ?? idRef) && <span className="mt-[6px] shrink-0 whitespace-nowrap font-mono text-[11px]" style={{ color: DIM }} data-sheet-id>{idLabel ?? idRef}</span>}
          <span className="ml-1 flex shrink-0 items-center gap-1.5">
            {actions}
            {showTalk && (
              <button type="button" onClick={() => host?.talk({ kind, ref: idRef ?? "" })} className="inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-[12px] transition-colors hover:bg-sol-bg-highlight/60" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)", color: "var(--sol-text-secondary)" }} title={`Put ${talk!.name}'s conversation on the left`} data-sheet-talk={talk!.conversationId}>
                <MessageSquare className="h-3 w-3" /> Talk to {talk!.name}
              </button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md hover:bg-sol-bg-highlight/60" style={{ color: "var(--sol-text-muted)" }} aria-label="More" data-sheet-menu>
                  <Ellipsis className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[190px]">
                {menu.filter((m) => !m.danger).map((m) => <DropdownMenuItem key={m.label} onSelect={m.onSelect}>{m.label}</DropdownMenuItem>)}
                {link && <DropdownMenuItem onSelect={() => void copyText(`${window.location.origin}${link}`, "Link copied")} data-sheet-copy-link>Copy link</DropdownMenuItem>}
                {menu.some((m) => m.danger) && <DropdownMenuSeparator />}
                {menu.filter((m) => m.danger).map((m) => <DropdownMenuItem key={m.label} onSelect={m.onSelect} className="text-[var(--sol-red)] focus:text-[var(--sol-red)]">{m.label}</DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </div>

        {cells.length > 0 && (
          <div className="mt-[9px] flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12px]" style={{ color: "var(--sol-text-muted)" }} data-sheet-facts>
            {cells.map((c, i) => (
              <Fragment key={i}>
                {i > 0 && <span aria-hidden className="h-[3px] w-[3px] rounded-full" style={{ background: DIM }} />}
                <span className="inline-flex min-w-0 items-center gap-1.5">{c}</span>
              </Fragment>
            ))}
          </div>
        )}
        {serves && serves.length > 0 && (
          <div className="mt-2.5 flex min-w-0 items-baseline gap-2 text-[12px]" data-sheet-serves>
            <span className="shrink-0" style={{ color: DIM }}>Serves</span>
            <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-1" style={{ color: "var(--sol-text-secondary)" }}>
              {serves.map((n) => <ObjectLink key={`${n.kind}:${n.ref}`} n={n} />)}
            </span>
          </div>
        )}
        {showAsk && ask && ("seat" in ask ? <AskBox seat={ask.seat} /> : <AskBox person={ask.person} />)}
        {loading ? <p className="mt-6 text-[12.5px]" style={{ color: DIM }}>Loading…</p> : children}
      </div>
    </div>
  );
}

/** The object's name: the serif heading, an input in place while renaming. A
 *  sheet opened by New opens with it focused and selected. */
function SheetTitle({ title, onRename, focus, onSettled }: { title: string; onRename?: (title: string) => void; focus: boolean; onSettled?: () => void }) {
  const [editing, setEditing] = useState(focus && !!onRename);
  const [draft, setDraft] = useState(title);
  const input = useRef<HTMLInputElement>(null);
  useWatchEffect(() => {
    const el = input.current;
    if (!editing || !el) return;
    const take = () => { el.focus(); el.select(); };
    take();
    // The menu that opened this sheet (New ▸ Goal) may hold focus until it
    // finishes closing; the name takes it back on the next frame.
    const frame = requestAnimationFrame(() => { if (document.activeElement !== el) take(); });
    return () => cancelAnimationFrame(frame);
  }, [editing]);
  useWatchEffect(() => { if (focus && onRename) { setDraft(title); setEditing(true); } }, [focus]);
  const settle = () => { setEditing(false); if (focus) onSettled?.(); };
  const commit = () => {
    settle();
    const next = draft.trim();
    if (next && next !== title) onRename?.(next);
  };
  // The name shrinks with a narrow sheet and wraps between words; a word
  // breaks only when it is wider than the sheet on its own.
  const heading = "text-[clamp(18px,5cqi,22px)] leading-[1.2] tracking-[-0.01em] [overflow-wrap:break-word] [word-break:normal]";
  if (editing) {
    return (
      <input
        ref={input}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDraft(title); settle(); }
        }}
        aria-label="Name"
        className={cn(heading, "w-full rounded-md bg-transparent px-1 -mx-1 outline-none ring-1 ring-[color-mix(in_srgb,var(--sol-cyan)_55%,transparent)]")}
        style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }}
        data-sheet-title-input
      />
    );
  }
  return (
    <h1
      className={cn(heading, onRename && "cursor-text rounded-md -mx-1 px-1 hover:bg-sol-bg-highlight/40")}
      style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)", fontWeight: 500 }}
      onClick={onRename ? () => { setDraft(title); setEditing(true); } : undefined}
      title={onRename ? "Rename" : undefined}
      data-sheet-title
    >
      {title}
    </h1>
  );
}

/** One of a sheet's sections: the small heading, an optional action at its
 *  right, then the body. Its heading is SectionHead, the one the goal
 *  sheet's sections (RecordSection) draw too, so a heading sits at the same
 *  height and rhythm on every kind. */
export function SheetSection({ title, action, children, data }: { title: string; action?: ReactNode; children: ReactNode; data?: string }) {
  return (
    <section className="mt-5" data-sheet-section={data ?? title}>
      <SectionHead label={title} action={action} />
      {children}
    </section>
  );
}

/** The record and the activity, folded at the foot of a sheet. */
export function SheetFolds({ children }: { children: ReactNode }) {
  return <div className="mt-5 border-b" style={{ borderColor: RULE }} data-sheet-folds>{children}</div>;
}

export function SheetFold({ title, hint, children, defaultOpen = false }: { title: string; hint?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t" style={{ borderColor: RULE }} data-sheet-fold={title} data-open={open ? "" : undefined}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-2 px-1 py-2.5 text-left text-[12.5px] hover:text-[var(--sol-text)]" style={{ color: "var(--sol-text-muted)" }}>
        <span aria-hidden className={cn("inline-block w-3 text-[10px] transition-transform", open && "rotate-90")}>▸</span>
        {title}
        {hint && <span className="ml-auto truncate text-[11.5px]" style={{ color: DIM }}>{hint}</span>}
      </button>
      {open && <div className="pb-3">{children}</div>}
    </div>
  );
}
