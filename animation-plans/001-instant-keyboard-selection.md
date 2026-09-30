# 001 — Make keyboard-driven selection instant

- **Status**: DONE
- **Commit**: 3efe31bb3
- **Severity**: HIGH
- **Category**: Purpose & frequency
- **Estimated scope**: 5 files, className edits only

## Problem

The surfaces people drive with the keyboard hundreds of times a day fade their selection instead of moving it. A key press should light the next row in the same frame; a 150ms color fade makes fast j/k or arrow presses leave a trail of half-lit rows and makes navigation feel laggy.

1. Session cards in the inbox list use `transition-all`, so moving the selection with j/k fades the old and new rows' background, animates the `border-l-2` width of the active row, and animates the drag `scale`:

```tsx
// packages/web/components/GlobalSessionPanel.tsx:2359 — current
className={`relative group transition-all overflow-hidden ${isDraggingCard ? "opacity-35 scale-[0.99]" : ""} ${isDragOver ? "ring-1 ring-inset ring-violet-400/40 bg-violet-500/10" : ""} ${isSelected ? SELECTED_CARD_CLASS : ""} ${ ...
// packages/web/components/GlobalSessionPanel.tsx:2516 — current (second card variant)
className={`relative group transition-all overflow-hidden ${isDraggingCard ? "opacity-35 scale-[0.99]" : ""} ${isDragOver ? "ring-1 ring-inset ring-sol-cyan bg-sol-cyan/10" : ""} ${isSelected ? ...
```

2. Command palette rows fade their highlight on every arrow press:

```tsx
// packages/web/components/CommandPalette.tsx:2319 — current
const itemClass = "flex items-center gap-3 px-2.5 py-2 mx-1 rounded-lg text-sm text-sol-text-muted cursor-pointer transition-colors data-[selected=true]:bg-sol-cyan/10 data-[selected=true]:text-sol-text";
// packages/web/components/CommandPalette.tsx:1233-1234 — current (picker modes)
const itemClass = (i: number) =>
  `w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
```

3. Dropdown and context menu items fade keyboard focus:

```tsx
// packages/web/components/ui/dropdown-menu.tsx:85 (also :101 and :125) — current
"relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent ..."
```
`packages/web/components/ui/context-menu.tsx:158-161` builds its `ITEM` on these items, so it inherits the fade.

4. The settings modal remounts its panel with `key={active.id}`, so every tab switch (mouse or keyboard) replays a 300ms, 8px fade-slide:

```tsx
// packages/web/components/settings/SettingsModal.tsx:293 — current
<div key={active.id} className="scrollbar-auto flex-1 overflow-y-auto px-4 sm:px-6 py-5 animate-fadeSlideIn">
```

## Target

- Selection, highlight and keyboard focus change in the same frame. No transition on background, color or border for these rows.
- Session cards still fade the drag state (`opacity-35`) because drag is pointer-driven and occasional: keep a transition limited to `opacity` only, `duration-150`.
- Hover colors on the palette and menu rows also snap. That's fine: these rows are hit constantly, and Raycast and native menus have no hover fade either.
- The settings panel switches content instantly. The modal's own entrance (SettingsModal.tsx:215) is unchanged.

## Repo conventions to follow

- The palette's open and close already have no animation (CommandPalette.tsx:2368-2372). That is the model: this plan extends the same rule to the rows inside it.
- Tailwind 3.4 utility classes. `transition-opacity` is the existing single-property utility (used in e.g. `components/ui/dialog.tsx:52`).

## Steps

1. `packages/web/components/GlobalSessionPanel.tsx:2359` and `:2516`: replace `transition-all` with `transition-opacity duration-150`. Leave every other class untouched.
2. `packages/web/components/CommandPalette.tsx:2319`: delete ` transition-colors` from the string.
3. `packages/web/components/CommandPalette.tsx:1234`: delete `transition-colors ` from the template string.
4. `packages/web/components/ui/dropdown-menu.tsx:85`, `:101`, `:125`: delete ` transition-colors` from each item class string.
5. `packages/web/components/settings/SettingsModal.tsx:293`: remove ` animate-fadeSlideIn` from the className. Keep `key={active.id}` (it resets the panel's scroll position on tab switch).
6. Run `grep -n "transition" packages/web/components/CommandPalette*.tsx` and confirm no remaining transition applies to a row that moves with the arrow keys. If one does, STOP and report it rather than editing it.

## Boundaries

- Do NOT touch the palette overlay, the dialog or any popover entrance animation.
- Do NOT change hover or selected colors, only remove the transitions.
- Do NOT touch `SELECTED_CARD_CLASS` or any drag logic.
- If a line doesn't match the excerpts above (drift since 3efe31bb3), STOP and report instead of improvising.

## Verification

- **Mechanical**: `cast check web` reports 0 errors.
- **Feel check** (dev server, http://localhost:3200):
  - Inbox: hold j for a second. Each row lights fully the instant it is selected; no row is left mid-fade behind the cursor.
  - Drag a session card: it still fades to 35% opacity smoothly.
  - Cmd+K, then hold the down arrow: the highlight jumps row to row with no fade.
  - Open any dropdown and a right-click context menu, arrow through the items: the highlight jumps.
  - Settings: click through tabs and press the keyboard tab shortcut if any: content swaps with no slide.
  - DevTools Animations panel at 10%: pressing j records no transition on session cards.
- **Done when**: the grep in step 6 is clean, and none of the surfaces above records a background or color transition in the Animations panel.
