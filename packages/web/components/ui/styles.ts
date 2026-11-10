// The Modern style's class strings (the opt-in third interface style; Classic
// and Minimal never see it). The primitives in components/ui keep exactly the
// classes they drew before Modern existed, and add these on top: every class
// here carries the `modern:` variant (`.modern-style &`), so it only applies
// with .modern-style on <html>, and, at one class more of specificity, it
// wins over the Classic class it replaces there.
//
// Every value comes from the primitive tokens (app/globals.css, "The Modern
// style's primitive system") and the sol-* theme colours; nothing here names a
// colour of its own.
//
// What that costs: in Modern, a call site's own un-prefixed class loses to a
// primitive's `modern:` class for the same property (cn() cannot merge across
// variants). A call site that must keep its own value in Modern says so with
// the variant too (`modern:p-0`); tailwind-merge then lets the call site's
// win, since both carry `modern:`. The primitives only reach for the
// properties the Modern look needs, to keep that rare.
//
// `focusRing` is the unprefixed ring, for components that only render in
// Modern (empty-state, ErrorBoundary's Modern panel).
//
// The primitives began as shadcn scaffolds and are hand-maintained.
// components.json keeps `cssVariables: false` so the shadcn CLI never writes
// its own palette into globals.css; a component it scaffolds is rebuilt on
// these tokens (and relative imports, which mobile's bundler needs) before it
// lands.

/** The one focus ring: 2px of the accent at half strength, 1px off the edge,
 *  on keyboard focus only. The gap is transparent, so it reads on any surface. */
export const focusRing =
  "outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--focus-ring)]";

/** The ring in Modern, and Classic's rings (a `ring-*` box shadow, or an
 *  outline) turned off there. */
export const modernFocusRing =
  "modern:outline-none modern:focus-visible:outline modern:focus-visible:outline-2 modern:focus-visible:outline-offset-1 modern:focus-visible:outline-[color:var(--focus-ring)] modern:focus-visible:ring-0 modern:focus-visible:ring-offset-0 modern:focus:ring-0 modern:focus:ring-offset-0";

/** Something that floats over the page: a white card on the hairline with the
 *  popover shadow. Popovers, menus, hover cards and tooltips wear it. */
export const modernFloating =
  "modern:rounded-card modern:border-sol-border modern:bg-sol-card modern:text-sol-text modern:shadow-popover modern:backdrop-blur-none";

/** How a floating surface arrives and leaves: 160ms, a 2% grow, a few pixels
 *  of drift from the side it opens on (Classic's animate-in classes stay; these
 *  retune their variables). The reduced-motion clamp in globals.css flattens it. */
export const modernPopMotion =
  "modern:duration-pop modern:ease-ui modern:data-[state=open]:zoom-in-[0.98] modern:data-[state=closed]:zoom-out-[0.98] modern:data-[side=bottom]:slide-in-from-top-1 modern:data-[side=left]:slide-in-from-right-1 modern:data-[side=right]:slide-in-from-left-1 modern:data-[side=top]:slide-in-from-bottom-1";

/** A text field's face (Input, Textarea, SelectBox): white on the hairline,
 *  the border darkening on hover, the ring on focus, no shadow. */
export const modernField =
  `modern:rounded-control modern:border-sol-border modern:bg-sol-card modern:text-sol-text modern:shadow-none modern:placeholder:text-sol-text-dim modern:hover:border-sol-text-dim/50 modern:aria-[invalid=true]:border-sol-red/70 modern:transition-[border-color,background-color] modern:duration-press modern:ease-ui ${modernFocusRing}`;

// ── Menus: the dropdown (dropdown-menu.tsx) and the right-click menu
// (context-menu.tsx) are one style in Modern, built from these. ──────────────

/** One row: 28px tall, 13px text, 6px corners, a cyan wash when highlighted
 *  (pointer or keys), 14px icons. The right-click menu's own row classes lose
 *  to these in Modern, so both menus draw the same row. */
export const modernMenuItem =
  "modern:min-h-control-sm modern:gap-2 modern:rounded-control modern:px-2 modern:py-1 modern:text-ui modern:focus:bg-sol-cyan/10 modern:data-[highlighted]:bg-sol-cyan/10 modern:[&>svg]:size-3.5";

/** A group caption, in sentence case. */
export const modernMenuLabel =
  "modern:px-2 modern:pb-1 modern:pt-2 modern:text-meta modern:font-medium modern:normal-case modern:tracking-normal modern:text-sol-text-dim";

/** The rule between groups, edge to edge inside the panel. */
export const modernMenuSeparator = "modern:-mx-1 modern:my-1 modern:bg-sol-border/70";

/** The right-aligned slot for a shortcut or a live value. */
export const modernMenuTrailing =
  "modern:pl-4 modern:text-meta modern:tracking-normal modern:opacity-100 modern:text-sol-text-dim";

/** Where a checkbox or radio row draws its mark. */
export const modernMenuIndicator = "modern:text-sol-cyan";
