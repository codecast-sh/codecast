# 002 — Stop the chunk hint jumping when it appears

- **Status**: TODO
- **Commit**: 3efe31bb3
- **Severity**: HIGH
- **Category**: Physicality & origin (a transform conflict bug)
- **Estimated scope**: 1 file, 1 line

## Problem

In message review, the keyboard-lit chunk shows a small "C quote" chip just above its top-right corner. The chip positions itself with a `transform`, and its entrance keyframe also sets `transform`, which replaces it for the duration of the animation:

```css
/* packages/web/app/globals.css:2217-2236 — current (excerpt) */
.cc-active-hint {
  position: absolute;
  right: -0.5rem;
  transform: translateY(calc(-100% - 2px));
  ...
  animation: ccPop 120ms ease-out;
  transition: top 120ms ease;
}
```

```css
/* packages/web/app/globals.css:2722-2731 — current */
@keyframes ccPop {
  from { opacity: 0; transform: var(--cc-pop-from, scale(0.94)); }
  to   { opacity: 1; transform: var(--cc-pop-to, scale(1)); }
}
```

`--cc-pop-from` and `--cc-pop-to` are never set anywhere in the repo, so for 120ms the chip is drawn at `scale(...)` with no `translateY`, one chip-height too low and on top of the chunk's first line, then it snaps up when the animation ends. It mounts from `packages/web/components/MessageReview.tsx:451` each time the hint becomes visible, which is driven by keyboard navigation.

It also doesn't need an entrance at all: it appears as the result of a key press, and keyboard-driven UI should respond in the same frame.

## Target

The chip appears in its final position immediately. Its `top` transition stays, because it moves together with `.cc-active-overlay` (globals.css:2210, `transition: top 120ms ease, height 120ms ease`), and the two must stay aligned while the overlay glides between chunks.

```css
/* target */
.cc-active-hint {
  ...
  transform: translateY(calc(-100% - 2px));
  ...
  transition: top 120ms ease;
}
```

## Repo conventions to follow

- `ccPop` has other users; do not change or delete the keyframe. Only this rule stops using it.

## Steps

1. `packages/web/app/globals.css`, inside `.cc-active-hint` (around line 2234): delete the line `  animation: ccPop 120ms ease-out;`. Nothing else.
2. Run `grep -n "ccPop" packages/web/app/globals.css packages/web/components -r` and confirm the keyframe still has other users (so it isn't now dead). If this was its only user, delete the `@keyframes ccPop` block too.

## Boundaries

- Do NOT touch `.cc-active-overlay` or its transition.
- Do NOT touch `MessageReview.tsx`.
- If the rule doesn't match the excerpt (drift since 3efe31bb3), STOP and report.

## Verification

- **Mechanical**: `cast check web` reports 0 errors (CSS change only; this confirms nothing else broke).
- **Feel check**: open a conversation, enter review mode, move between chunks with the keyboard.
  - The "C quote" chip is always above the chunk's top-right corner, never over the first line of text, including the first frame it appears.
  - DevTools Animations panel at 10%: step through the chip's appearance; there is no frame where it sits lower than its resting position.
- **Done when**: no animation is recorded on `.cc-active-hint` when it mounts.
