# 005 — Replace transition-all on the message list and the composer

- **Status**: DONE
- **Commit**: 3efe31bb3
- **Severity**: MEDIUM
- **Category**: Performance
- **Estimated scope**: 2 files, className edits

## Problem

`transition-all` animates every property that changes, including layout ones. On the two busiest surfaces in the app it makes layout changes animate:

1. **Every message wrapper.** Highlighting or share-selecting a message adds padding, negative margin and a 2px border, and `transition-all` animates all of them for 150ms, re-laying-out the message list on each frame:

```tsx
// packages/web/components/conversation/blocks/turnBlocks.tsx:1254 — current (assistant)
className={`group relative scroll-mt-20 ${onlyToolCalls ? "mb-0.5" : condensed ? "mb-2.5" : "mb-6"} transition-all ${isHighlighted ? "ring-2 ring-sol-yellow shadow-lg rounded-lg p-2 -m-2 message-highlight" : ""} ... ${isSelectedForShare ? "bg-sol-cyan/10 rounded-lg p-2 -m-2 border-2 ...
// packages/web/components/conversation/blocks/turnBlocks.tsx:390 — current (user)
className={`group relative scroll-mt-20 -mx-4 px-4 py-4 rounded-lg ${effectivelyCollapsed ? "mb-2" : "mb-6"} transition-all ${isHighlighted ? "ring-2 ring-sol-yellow shadow-lg rounded-lg message-highlight" : ""} ...
```
Collapsing a user message also animates its bottom margin (`mb-2` vs `mb-6`).

2. **The composer form** animates width on every column-width, mode or session change:

```tsx
// packages/web/components/MessageInput.tsx:2447 — current
<form onSubmit={handleFormSubmit} className={bareComposer ? "w-full" : `mx-auto transition-all duration-200 ease-out ${colClass}`}>
```

3. **The permission-mode label** animates `max-width` for 300ms when cycled from the keyboard:

```tsx
// packages/web/components/MessageInput.tsx:2344-2345 — current
className={`text-[10px] font-mono transition-all duration-300 ease-out overflow-hidden whitespace-nowrap ${
  showModeLabel ? "max-w-[80px] opacity-100 translate-x-0" : "max-w-0 opacity-0 -translate-x-1"
```

4. **Composer icon buttons** use `transition-all` for a color and background hover (`MessageInput.tsx` lines ~2574, 2586, 2599, 2661, 2672, 2684, 2697), e.g.:

```tsx
className="w-7 h-7 rounded-full transition-all flex items-center justify-center text-[...] hover:text-sol-yellow hover:bg-sol-yellow/10"
```

## Target

- Message wrappers: transition only what should fade, `transition-[background-color,box-shadow,border-color]` at the Tailwind default 150ms. Padding, margin and border width snap. The `message-highlight` keyframe (`highlightPulse`) still carries the highlight's motion.
- Composer form: no transition. Width changes snap into place.
- Permission-mode label: `transition-[opacity,transform] duration-150 ease-out`. `max-width` snaps; the text fades and slides 4px in 150ms.
- Composer icon buttons: `transition-colors` (Tailwind's color + background-color + border-color at 150ms).

## Repo conventions to follow

- Tailwind 3.4 arbitrary transition properties, e.g. `transition-[color,background-color,transform]` already used at `packages/web/components/TriggerRow.tsx:147`.

## Steps

1. `turnBlocks.tsx:1254` and `turnBlocks.tsx:390`: replace `transition-all` with `transition-[background-color,box-shadow,border-color]`.
2. `MessageInput.tsx:2447`: replace `` `mx-auto transition-all duration-200 ease-out ${colClass}` `` with `` `mx-auto ${colClass}` ``.
3. `MessageInput.tsx:2344`: replace `transition-all duration-300 ease-out` with `transition-[opacity,transform] duration-150 ease-out`.
4. In `MessageInput.tsx`, for every className that contains `transition-all` AND whose only changing classes are `hover:text-*` / `hover:bg-*` (the icon buttons listed above), replace `transition-all` with `transition-colors`. Run `grep -n "transition-all" packages/web/components/MessageInput.tsx` afterwards; for any remaining hit, read it and STOP to report if it changes anything other than color, background or opacity.

## Boundaries

- Only `turnBlocks.tsx` and `MessageInput.tsx`. The other ~120 `transition-all` uses are out of scope for this plan.
- Do NOT change any color, spacing or highlight class, only the transition utilities.
- If a line doesn't match (drift since 3efe31bb3), STOP and report.

## Verification

- **Mechanical**: `cast check web` reports 0 errors.
- **Feel check**:
  - Follow a deep link to a message (highlight): the yellow ring appears and pulses; the message does not visibly grow or shift over 150ms.
  - Enter share-selection mode and click messages: the cyan background fades; the box does not animate its padding.
  - Collapse and expand a long user message: the gap below it snaps.
  - Cycle the permission mode with its keyboard shortcut: the label fades in within 150ms; the dot beside it doesn't slide over 300ms.
  - Hover composer icon buttons: color still fades.
  - Performance panel while clicking through share-selection on a long conversation: no Layout work repeating across frames after a click.
- **Done when**: `grep -c "transition-all" packages/web/components/conversation/blocks/turnBlocks.tsx` is 0 for the two wrappers, and the checks above hold.
