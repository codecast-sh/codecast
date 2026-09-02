"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuPortal,
} from "./dropdown-menu";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { getShortcutsForAction, formatShortcutParts } from "../../shortcuts";
import type { ShortcutAction } from "../../shortcuts";
import { cn } from "@/lib/utils";

// The one right-click system. Every object surface (session rows, task cards,
// docs, triggers, messages, tabs…) opens THIS, so "what does right-click do"
// has a single answer and a single look. Items call the same store actions the
// command palette calls — the menu is a presentation, never a second code path.
//
// Mechanics: a Radix DropdownMenu whose trigger is a zero-size span parked at
// the cursor. Radix then owns placement, collision flipping, click-away, Esc,
// typeahead and submenu behavior. One menu instance serves an entire
// virtualized list — rows only call `open(e, payload)` — so there is no
// per-row portal cost.
//
// Shift+right-click falls through to the browser's native menu (inspect,
// copy image…), matching the convention of native-feeling web apps.

type MenuAt<T> = { x: number; y: number; payload: T };

export type ContextMenuState<T> = {
  menu: MenuAt<T> | null;
  /** `force` skips the stand-down (links, selections): for an element that
   *  owns its own menu, such as a file link. */
  open: (e: React.MouseEvent, payload: T, opts?: { force?: boolean }) => void;
  close: () => void;
};

export function useContextMenu<T = void>(): ContextMenuState<T> {
  const [menu, setMenu] = React.useState<MenuAt<T> | null>(null);
  const open = React.useCallback((e: React.MouseEvent, payload: T, opts?: { force?: boolean }) => {
    if (e.shiftKey) return;
    // Stand down where the native menu is the right answer: links (open in
    // new tab), editable fields (spellcheck, paste), and live text selections
    // (copy). The app menu takes everything else.
    const target = e.target as HTMLElement | null;
    if (!opts?.force) {
      if (target?.closest?.('a[href], input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')) return;
      const sel = typeof window !== "undefined" ? window.getSelection() : null;
      if (sel && !sel.isCollapsed && target && sel.containsNode?.(target, true)) return;
    }
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, payload });
  }, []);
  const close = React.useCallback(() => setMenu(null), []);
  // Stable identity while the menu is closed. Callers pass this object (or a
  // callback depending on it) down to every row of a list; a fresh object per
  // render would defeat the rows' memo on every parent render.
  return React.useMemo(() => ({ menu, open, close }), [menu, open, close]);
}

const SURFACE = cn(
  "min-w-[228px] max-w-[320px] p-1 rounded-xl",
  "border border-[color-mix(in_srgb,var(--sol-border)_50%,transparent)]",
  "bg-[color-mix(in_srgb,var(--sol-card)_94%,transparent)] backdrop-blur-md",
  "shadow-[0_14px_40px_-10px_rgba(0,0,0,0.35),0_3px_10px_rgba(0,0,0,0.10)]",
  "text-sol-text",
);

/** Render at the list/page root; rows call `state.open(e, payload)`. */
export function ContextMenu<T>({
  state,
  children,
}: {
  state: ContextMenuState<T>;
  children: (payload: T) => React.ReactNode;
}) {
  const { menu, close } = state;
  if (!menu) return null;
  // The whole subtree portals to document.body: a transformed ancestor (any
  // virtualized row) would otherwise become the anchor's containing block —
  // position:fixed goes ancestor-relative under transform — and drag the menu
  // hundreds of pixels off the cursor.
  return createPortal(
    <DropdownMenu open onOpenChange={(o) => !o && close()}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          style={{ position: "fixed", left: menu.x, top: menu.y, width: 1, height: 1, pointerEvents: "none" }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={2} collisionPadding={8} className={SURFACE}>
        {children(menu.payload)}
      </DropdownMenuContent>
    </DropdownMenu>,
    document.body,
  );
}

// "group" so slot content (icons, dots) can restyle on item focus without
// [&>svg] selectors — those would override per-option icon colors (a red
// Urgent icon must stay red).
const ITEM = cn(
  "group text-[13px] leading-none rounded-lg px-2.5 py-2 gap-2.5",
  "text-sol-text-secondary focus:bg-sol-cyan/10 focus:text-sol-text",
);

const DANGER = cn("text-sol-red/90 focus:bg-sol-red/10 focus:text-sol-red");

function ShortcutHint({ action }: { action: ShortcutAction }) {
  const def = getShortcutsForAction(action)[0];
  if (!def) return null;
  return (
    <span className="ml-auto pl-4 flex items-center gap-[3px]">
      {formatShortcutParts(def).map((part, i) => (
        <KeyCap key={i} size="xs">{part}</KeyCap>
      ))}
    </span>
  );
}

export function CtxItem({
  icon: Icon,
  iconClassName,
  leading,
  danger,
  shortcut,
  trailing,
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuItem> & {
  icon?: React.ComponentType<{ className?: string }>;
  /** Color/size override for the icon (e.g. a status color). An explicit text
   *  color here suppresses the default dim/focus-cyan treatment. */
  iconClassName?: string;
  /** Arbitrary leading slot when the marker isn't a lucide icon (color dots,
   *  avatars). Rendered as a flex child BEFORE the label — never put visual
   *  elements inside `children`, which is a truncating text span. */
  leading?: React.ReactNode;
  danger?: boolean;
  /** Registered shortcut whose key hint renders right-aligned as keycaps. */
  shortcut?: ShortcutAction;
  /** Free-form right-aligned slot (badges, live values). */
  trailing?: React.ReactNode;
}) {
  const iconHasColor = !!iconClassName && iconClassName.includes("text-");
  return (
    <DropdownMenuItem className={cn(ITEM, danger && DANGER, className)} {...props}>
      {Icon && (
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            !iconHasColor && (danger ? "text-sol-red/70 group-focus:text-sol-red" : "text-sol-text-dim group-focus:text-sol-cyan"),
            iconClassName,
          )}
        />
      )}
      {leading}
      <span className="truncate">{children}</span>
      {shortcut ? <ShortcutHint action={shortcut} /> : null}
      {trailing ? <span className="ml-auto pl-4 flex items-center">{trailing}</span> : null}
    </DropdownMenuItem>
  );
}

export function CtxCheckItem({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuCheckboxItem>) {
  return (
    <DropdownMenuCheckboxItem
      className={cn(
        "text-[13px] leading-none rounded-lg py-2 pr-2.5 gap-2.5",
        "text-sol-text-secondary focus:bg-sol-cyan/10 focus:text-sol-text",
      )}
      {...props}
    />
  );
}

/** Section header: object identity or a group caption. */
export function CtxLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-sol-text-dim select-none">
      {children}
    </div>
  );
}

/** Identity header for menus that name their object (title + mono short id). */
export function CtxHeader({ title, id }: { title: React.ReactNode; id?: string }) {
  return (
    <div className="px-2.5 pt-2 pb-1.5 flex items-baseline gap-2 select-none border-b border-[color-mix(in_srgb,var(--sol-border)_28%,transparent)] mb-1">
      <span className="text-[12px] font-medium text-sol-text truncate">{title}</span>
      {id && <span className="ml-auto text-[10px] font-mono text-sol-text-dim shrink-0">{id}</span>}
    </div>
  );
}

export function CtxSeparator() {
  return (
    <DropdownMenuSeparator className="bg-[color-mix(in_srgb,var(--sol-border)_28%,transparent)] mx-1.5" />
  );
}

export const CtxSub = DropdownMenuSub;

export function CtxSubTrigger({
  icon: Icon,
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuSubTrigger> & {
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <DropdownMenuSubTrigger
      className={cn(ITEM, "data-[state=open]:bg-sol-cyan/10 data-[state=open]:text-sol-text", className)}
      {...props}
    >
      {Icon && (
        <Icon className="size-3.5 shrink-0 text-sol-text-dim group-focus:text-sol-cyan group-data-[state=open]:text-sol-cyan" />
      )}
      <span className="truncate">{children}</span>
    </DropdownMenuSubTrigger>
  );
}

export function CtxSubContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuSubContent>) {
  // Portaled OUT of the parent content: DropdownMenuContent is a scroll
  // container (overflow-x-hidden), so an unportaled submenu is measured
  // against that ~250px box — floating-ui flips it to a spot the overflow
  // then clips, and the submenu "opens" invisibly. On body it positions
  // against the viewport, and Radix's pointer grace polygon (the diagonal
  // safe area between trigger and content) works over real geometry.
  return (
    <DropdownMenuPortal>
      <DropdownMenuSubContent
        sideOffset={4}
        collisionPadding={8}
        className={cn(SURFACE, "max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto", className)}
        {...props}
      />
    </DropdownMenuPortal>
  );
}

/** The menu surface, for a dropdown that must look like the right-click menu
 *  (the triage bar's "more" button hosts SessionMenuItems this way). */
export const CTX_SURFACE = SURFACE;
