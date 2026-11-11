// The primitives' Modern looks as class strings, for controls that are drawn
// by hand instead of through the primitive (a raw <button> styled as an
// outline button, a <span> styled as a badge, a tab strip, an overlay that
// draws its own scrim and panel). A call site keeps its own classes and adds
// one of these:
//
//   className={cn(existing, modernButton({ variant: "outline", size: "sm" }))}
//
// Every class here carries the `modern:` variant (`.modern-style &`), so
// Classic and Minimal never see them, and at one class more of specificity
// each one wins over the call site's un-prefixed class for the same property
// in Modern. The values are the primitives' own (button.tsx, badge.tsx,
// tabs.tsx, dialog.tsx, popover.tsx, styles.ts): one radius, the control
// heights, the one focus ring, the sol-* tokens. Changing a Modern look here
// changes every hand-built control that wears it.
//
// Tailwind only generates a class it finds written out whole, so every tone
// below is spelled out rather than assembled.

import { cn } from "../../lib/utils";
import { modernField, modernFloating, modernMenuItem, modernMenuLabel, modernMenuSeparator } from "./styles";

export { modernField, modernMenuItem, modernMenuLabel, modernMenuSeparator };

const join = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

/** A look with a call site's own Modern overrides merged in: tailwind-merge
 *  drops the look's class for any property the override sets, so the
 *  override wins in Modern whatever order the stylesheet puts them in (two
 *  `modern:` classes for one property side by side would leave it to that
 *  order). Every look below takes the same overrides as its last argument. */
export function modernLook(look: string, extra?: string | false | null): string {
  return extra ? cn(look, extra) : look;
}

/** styles.ts's focus ring with its outline style written as a property:
 *  tailwind-merge reads a bare `outline` as a width and drops it beside
 *  `outline-2`, and these looks go through cn() at call sites. */
const RING = "modern:outline-none modern:focus-visible:[outline-style:solid] modern:focus-visible:outline-2 modern:focus-visible:outline-offset-1 modern:focus-visible:outline-[color:var(--focus-ring)] modern:focus-visible:ring-0 modern:focus-visible:ring-offset-0 modern:focus:ring-0 modern:focus:ring-offset-0";

// ── Buttons ────────────────────────────────────────────────────────────────

export type ModernButtonVariant = "primary" | "outline" | "secondary" | "ghost" | "danger" | "soft" | "link";
export type ModernButtonSize = "xs" | "sm" | "md" | "lg" | "icon-xs" | "icon-sm" | "icon";
export type ModernTone = "neutral" | "cyan" | "green" | "amber" | "yellow" | "orange" | "red" | "blue" | "violet" | "magenta";

/** What every hand-built button shares in Modern: the control radius, the
 *  press timing, the one focus ring, no lift, and a disabled face. */
const BUTTON_BASE = `modern:rounded-control modern:shadow-none modern:font-medium modern:transition-colors modern:duration-press modern:ease-ui modern:disabled:opacity-50 ${RING}`;

const BUTTON_VARIANT: Record<Exclude<ModernButtonVariant, "soft">, string> = {
  // The accent fill, its label the page colour (Button's primary in Modern).
  primary: "modern:border-transparent modern:bg-sol-cyan modern:text-sol-bg modern:hover:bg-sol-cyan/90 modern:hover:text-sol-bg",
  // A white face on the hairline (Button's outline in Modern).
  outline: "modern:border modern:border-sol-border modern:bg-sol-card modern:text-sol-text modern:hover:border-sol-text-dim/50 modern:hover:bg-sol-bg-alt modern:hover:text-sol-text",
  // A soft tray of the ink, no edge.
  secondary: "modern:border-transparent modern:bg-sol-text/[0.06] modern:text-sol-text modern:hover:bg-sol-text/10 modern:hover:text-sol-text",
  // No face until hovered.
  ghost: "modern:border-transparent modern:bg-transparent modern:text-sol-text-muted modern:hover:bg-sol-text/[0.06] modern:hover:text-sol-text",
  // The outline face with a red label: stop, delete, revoke.
  danger: "modern:border modern:border-sol-red/40 modern:bg-sol-card modern:text-sol-red modern:hover:border-sol-red/60 modern:hover:bg-sol-red/[0.06] modern:hover:text-sol-red",
  link: "modern:h-auto modern:border-transparent modern:bg-transparent modern:px-0 modern:text-sol-cyan modern:underline-offset-4 modern:hover:bg-transparent modern:hover:underline",
};

/** A soft tint of one accent, its label in the same accent: an action that
 *  belongs to a status (approve in green, retry in amber) or the quiet
 *  accent action beside a primary one. */
const SOFT_TONE: Record<ModernTone, string> = {
  neutral: "modern:border-transparent modern:bg-sol-text/[0.06] modern:text-sol-text-muted modern:hover:bg-sol-text/10 modern:hover:text-sol-text",
  cyan: "modern:border-transparent modern:bg-sol-cyan/10 modern:text-sol-cyan modern:hover:bg-sol-cyan/15 modern:hover:text-sol-cyan",
  green: "modern:border-transparent modern:bg-sol-green/10 modern:text-sol-green modern:hover:bg-sol-green/15 modern:hover:text-sol-green",
  amber: "modern:border-transparent modern:bg-sol-amber/10 modern:text-sol-amber modern:hover:bg-sol-amber/15 modern:hover:text-sol-amber",
  yellow: "modern:border-transparent modern:bg-sol-yellow/10 modern:text-sol-yellow modern:hover:bg-sol-yellow/15 modern:hover:text-sol-yellow",
  orange: "modern:border-transparent modern:bg-sol-orange/10 modern:text-sol-orange modern:hover:bg-sol-orange/15 modern:hover:text-sol-orange",
  red: "modern:border-transparent modern:bg-sol-red/10 modern:text-sol-red modern:hover:bg-sol-red/15 modern:hover:text-sol-red",
  blue: "modern:border-transparent modern:bg-sol-blue/10 modern:text-sol-blue modern:hover:bg-sol-blue/15 modern:hover:text-sol-blue",
  violet: "modern:border-transparent modern:bg-sol-violet/10 modern:text-sol-violet modern:hover:bg-sol-violet/15 modern:hover:text-sol-violet",
  magenta: "modern:border-transparent modern:bg-sol-magenta/10 modern:text-sol-magenta modern:hover:bg-sol-magenta/15 modern:hover:text-sol-magenta",
};

// Button's sizes in Modern: 24 (the floor for anything pressable), 28, 32,
// 36; icon buttons square at the same heights. Height, not padding, sets the
// size, so a call site's own py- loses, and a sized label stays on one line.
// `size: null` leaves a wrapping, row-sized button (a choice card) its own.
const BUTTON_SIZE: Record<ModernButtonSize, string> = {
  xs: "modern:whitespace-nowrap modern:h-6 modern:gap-1 modern:px-2 modern:py-0 modern:text-meta",
  sm: "modern:whitespace-nowrap modern:h-control-sm modern:gap-1.5 modern:px-2.5 modern:py-0 modern:text-meta",
  md: "modern:whitespace-nowrap modern:h-control-md modern:gap-1.5 modern:px-3 modern:py-0 modern:text-ui",
  lg: "modern:whitespace-nowrap modern:h-control-lg modern:gap-2 modern:px-4 modern:py-0 modern:text-body",
  "icon-xs": "modern:size-6 modern:shrink-0 modern:justify-center modern:p-0",
  "icon-sm": "modern:size-control-sm modern:shrink-0 modern:justify-center modern:p-0",
  icon: "modern:size-control-md modern:shrink-0 modern:justify-center modern:p-0",
};

/** The Button primitive's Modern face for a hand-built button. `tone` picks
 *  the accent for `soft` (cyan when omitted). Pass `size: null` to keep the
 *  call site's own height and padding (a row-sized or wrapping button). */
export function modernButton({
  variant = "outline",
  size = "sm",
  tone = "cyan",
}: { variant?: ModernButtonVariant; size?: ModernButtonSize | null; tone?: ModernTone } = {}, extra?: string): string {
  // A link sits in a line of text and takes no size.
  return modernLook(join(BUTTON_BASE, variant === "soft" ? SOFT_TONE[tone] : BUTTON_VARIANT[variant], variant !== "link" && size && BUTTON_SIZE[size]), extra);
}

// ── Pills and chips ────────────────────────────────────────────────────────

const PILL_TONE: Record<ModernTone, string> = {
  neutral: "modern:bg-sol-text/[0.07] modern:text-sol-text-muted",
  cyan: "modern:bg-sol-cyan/10 modern:text-sol-cyan",
  green: "modern:bg-sol-green/10 modern:text-sol-green",
  amber: "modern:bg-sol-amber/10 modern:text-sol-amber",
  yellow: "modern:bg-sol-yellow/10 modern:text-sol-yellow",
  orange: "modern:bg-sol-orange/10 modern:text-sol-orange",
  red: "modern:bg-sol-red/10 modern:text-sol-red",
  blue: "modern:bg-sol-blue/10 modern:text-sol-blue",
  violet: "modern:bg-sol-violet/10 modern:text-sol-violet",
  magenta: "modern:bg-sol-magenta/10 modern:text-sol-magenta",
};

/** Badge's Modern shape without a colour: 20px tall, 6px corners, no edge,
 *  12px medium text in sentence case. For a pill whose colour is data (a
 *  label's own colour) and stays the call site's. `block` keeps a pill that
 *  truncates its text a block, so the ellipsis still draws. */
export function modernPillShape({ block = false }: { block?: boolean } = {}, extra?: string): string {
  // The line height after the size: tailwind-merge lets a later text size
  // drop it.
  return modernLook(join(
    "modern:whitespace-nowrap modern:rounded-control modern:border-transparent modern:px-1.5 modern:py-0 modern:text-meta modern:font-medium modern:normal-case modern:tracking-normal modern:shadow-none",
    block ? "modern:block modern:h-5 modern:leading-5" : "modern:inline-flex modern:h-5 modern:items-center modern:gap-1",
  ), extra);
}

/** Badge's Modern face for a hand-built pill (a <span> drawn as a status tag,
 *  or a <Badge> whose own classes would lose to its variant in Modern): a
 *  soft tint of its colour behind text in the same colour, on the pill
 *  shape. */
export function modernPill({ tone = "neutral", block = false }: { tone?: ModernTone; block?: boolean } = {}, extra?: string): string {
  return modernLook(join(modernPillShape({ block }), PILL_TONE[tone]), extra);
}

const TONES = new Set<ModernTone>(["neutral", "cyan", "green", "amber", "yellow", "orange", "red", "blue", "violet", "magenta"]);

/** The tone a call site's own colour class names (`text-sol-yellow`,
 *  `bg-sol-green/10 text-sol-green`), for a pill whose colour is worked out at
 *  runtime (a status's): Tailwind cannot build `modern:` from a variable, so
 *  the colour maps onto a tone whose classes are written out. Anything else is
 *  neutral. */
export function modernToneOf(colorClasses: string | null | undefined): ModernTone {
  const m = /\btext-sol-([a-z]+)\b/.exec(colorClasses ?? "");
  return m && TONES.has(m[1] as ModernTone) ? (m[1] as ModernTone) : "neutral";
}

/** A toggleable filter chip (a facet, a status filter): the outline button's
 *  face at 28px, and the accent's soft tint with its label in the accent when
 *  it is on. */
export function modernChip({ active = false }: { active?: boolean } = {}, extra?: string): string {
  return modernLook(join(
    `modern:h-control-sm modern:gap-1.5 modern:rounded-control modern:border modern:px-2.5 modern:py-0 modern:text-meta modern:font-medium modern:normal-case modern:tracking-normal modern:shadow-none modern:transition-colors modern:duration-press modern:ease-ui ${RING}`,
    active
      ? "modern:border-sol-cyan/40 modern:bg-sol-cyan/10 modern:text-sol-cyan modern:hover:bg-sol-cyan/15 modern:hover:text-sol-cyan"
      : "modern:border-sol-border modern:bg-sol-card modern:text-sol-text-muted modern:hover:border-sol-text-dim/50 modern:hover:bg-sol-bg-alt modern:hover:text-sol-text",
  ), extra);
}

// ── Tabs ───────────────────────────────────────────────────────────────────

/** A hand-built tab strip in Modern: the soft tray Tabs and SegmentedToggle
 *  draw, sized to its tabs (28px tabs in a 2px inset: the 32px control). */
export const modernTabList =
  "modern:inline-flex modern:w-auto modern:items-center modern:gap-0.5 modern:rounded-control modern:border-0 modern:bg-sol-text/[0.06] modern:p-0.5 modern:shadow-none";

/** One tab in that tray: the open one raised in white on the hairline, the
 *  rest muted ink with no underline. */
export function modernTab({ active = false }: { active?: boolean } = {}, extra?: string): string {
  return modernLook(join(
    `modern:inline-flex modern:h-7 modern:items-center modern:gap-1.5 modern:rounded-[4px] modern:border-0 modern:px-2.5 modern:py-0 modern:text-ui modern:font-medium modern:normal-case modern:tracking-normal modern:transition-colors modern:duration-press modern:ease-ui ${RING}`,
    active
      ? "modern:bg-sol-card modern:text-sol-text modern:shadow-[0_0_0_1px_var(--sol-border)] modern:hover:bg-sol-card modern:hover:text-sol-text"
      : "modern:bg-transparent modern:text-sol-text-muted modern:shadow-none modern:hover:bg-transparent modern:hover:text-sol-text",
  ), extra);
}

// ── Overlays ───────────────────────────────────────────────────────────────

/** The dimmed page behind a hand-built dialog: Dialog's scrim in Modern. */
export const modernScrim = "modern:bg-black/40 modern:backdrop-blur-none";

/** A hand-built dialog's panel: Dialog's sheet of paper in Modern (14px
 *  corners, the dialog shadow, never taller than the window). It scrolls as
 *  a whole when its content is taller; a panel that scrolls a body of its
 *  own passes `scroll: false` and keeps it. */
export function modernDialog({ scroll = true }: { scroll?: boolean } = {}, extra?: string): string {
  return modernLook(join(
    "modern:max-h-[calc(100dvh-2rem)] modern:rounded-dialog modern:border modern:border-sol-border modern:bg-sol-card modern:text-sol-text modern:shadow-dialog",
    scroll && "modern:overflow-y-auto",
  ), extra);
}

/** A hand-built menu or flyout's panel: the floating surface popovers and
 *  menus wear in Modern, capped below the window and scrolling past it. */
export const modernPopover = `${modernFloating} modern:border modern:max-h-[min(32rem,calc(100dvh-4rem))] modern:overflow-y-auto`;

/** One row in a hand-built menu: the menu row Modern's dropdown and
 *  right-click menus draw (28px, 13px text, 6px corners, a cyan wash under
 *  the pointer), the chosen one in full ink. Its panel gets `modern:p-1` so
 *  the rounded rows sit inside it. */
export function modernMenuRow({ selected = false }: { selected?: boolean } = {}, extra?: string): string {
  return modernLook(join(
    "modern:min-h-control-sm modern:gap-2 modern:rounded-control modern:px-2 modern:py-1 modern:text-ui modern:transition-colors modern:duration-press modern:ease-ui modern:hover:bg-sol-cyan/10 modern:hover:text-sol-text modern:focus-visible:bg-sol-cyan/10 modern:focus-visible:outline-none",
    selected ? "modern:bg-transparent modern:font-medium modern:text-sol-text" : "modern:bg-transparent modern:text-sol-text-muted",
  ), extra);
}

// ── Rows and facts ─────────────────────────────────────────────────────────

/** A quiet machine fact (a pid, a path, a branch, a host): mono, the meta
 *  size, the dim ink. */
export const modernMonoFact = "modern:font-mono modern:text-meta modern:font-normal modern:text-sol-text-dim";
