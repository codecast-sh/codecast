# 003 — Repair the stage split morph (its transition is invalid CSS)

- **Status**: TODO
- **Commit**: 3efe31bb3
- **Severity**: HIGH
- **Category**: Performance / correctness
- **Estimated scope**: 1 file, 8 lines

## Problem

The split stage is designed so that splitting or closing a pane MORPHS: every cell glides to its new rect instead of jumping (`packages/web/components/stage/StageSplitView.tsx` header comment, lines 7-10: "a split or close changes only each cell's percent rect, so content never remounts and the cells animate to their new places"). Drag-resizing turns the motion off on purpose (`globals.css:3681-3682`, `.stage-resizing`).

The morph never runs. The transition names two timing functions per property:

```css
/* packages/web/app/globals.css:3644-3653 — current */
.stage-cell {
  position: absolute;
  overflow: hidden;
  background: var(--sol-bg);
  transition:
    left var(--cc-panel-motion) cubic-bezier(.2,.8,.25,1),
    top var(--cc-panel-motion) cubic-bezier(.2,.8,.25,1),
    width var(--cc-panel-motion) cubic-bezier(.2,.8,.25,1),
    height var(--cc-panel-motion) cubic-bezier(.2,.8,.25,1);
}
/* packages/web/app/globals.css:3665-3673 — current */
.stage-handle {
  ...
  transition:
    left var(--cc-panel-motion) cubic-bezier(.2,.8,.25,1),
    ... (same four lines)
}
```

`--cc-panel-motion` already contains a curve (`globals.css:3404`: `220ms cubic-bezier(0.32, 0.72, 0, 1)`; `globals.css:454` sets `180ms cubic-bezier(0.23, 1, 0.32, 1)` under `.minimal-style`). After substitution each item reads `left 220ms cubic-bezier(...) cubic-bezier(...)`, which is invalid at computed-value time, so the whole `transition` falls back to its initial value (none). Splits and closes teleport.

Every other user of the token writes it as `<property> var(--cc-panel-motion)` (e.g. `globals.css:1531`, `:1545`, `:3502`), which is correct.

## Target

```css
.stage-cell {
  position: absolute;
  overflow: hidden;
  background: var(--sol-bg);
  transition:
    left var(--cc-panel-motion),
    top var(--cc-panel-motion),
    width var(--cc-panel-motion),
    height var(--cc-panel-motion);
}
.stage-handle {
  ...
  transition:
    left var(--cc-panel-motion),
    top var(--cc-panel-motion),
    width var(--cc-panel-motion),
    height var(--cc-panel-motion);
}
```

This animates layout properties, which AUDIT rules normally flag. It is accepted here: it is one-shot, user-initiated (split/close, occasional), 220ms, and the percent-rect design is deliberate. Converting to FLIP transforms is out of scope.

## Repo conventions to follow

- `--cc-panel-motion` is the one shared panel motion ("One motion for every panel", `globals.css:3401-3403`). Use it bare, as `.cc-panel-width { transition: width var(--cc-panel-motion); }` does at `:3502`.

## Steps

1. `packages/web/app/globals.css:3649-3652`: in each of the four lines, delete ` cubic-bezier(.2,.8,.25,1)` so the line reads `left var(--cc-panel-motion),` etc.
2. `packages/web/app/globals.css:3669-3672`: same edit on the `.stage-handle` block.
3. Leave `.stage-resizing` (3681-3682) untouched.

## Boundaries

- Do NOT change `--cc-panel-motion`'s value(s).
- Do NOT touch `components/stage/StageSplitView.tsx` or `stageGeometry`.
- If the lines don't match (drift since 3efe31bb3), STOP and report.

## Verification

- **Mechanical**: in DevTools, select a `.stage-cell` and confirm the Computed panel shows `transition-property: left, top, width, height` and `transition-duration: 0.22s` (0.18s under the minimal style), not `all 0s`. `bun test packages/web/components/__tests__/stageSoloCell.mount.test.tsx` passes.
- **Feel check**:
  - Split a pane, then close one: the cells glide to their new rects over ~220ms instead of jumping.
  - Drag a split handle: the seam tracks the pointer 1:1 with no lag (the `.stage-resizing` override still wins).
  - Performance panel while splitting with a conversation and a terminal pane open: no long frames (>16ms) in a row across the morph. If there are, STOP and report the trace rather than tuning.
  - Emulate `prefers-reduced-motion: reduce`: the split jumps (the global reduced-motion rule clamps it).
- **Done when**: split and close animate, drag-resize does not.
