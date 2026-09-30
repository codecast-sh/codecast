# 004 — Reduced motion: keep spinners and the deliberate gentle fallbacks

- **Status**: DONE
- **Commit**: 3efe31bb3
- **Severity**: HIGH
- **Category**: Accessibility
- **Estimated scope**: 1 file, one block added

## Problem

A global rule clamps every animation and transition to near zero under reduced motion:

```css
/* packages/web/app/globals.css:805-814 — current */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

Two consequences:

1. **Loading indicators freeze.** Every `animate-spin` (84 uses in tsx), the app loader bar (`.app-loader-bar::after`, `globals.css:1044`, `app-loader-slide 1.5s ... infinite`) run one 0.01ms iteration and stop. A frozen spinner reads as "stuck", which is worse than no spinner. A small in-place rotation is not the vestibular motion reduced-motion protects against.
2. **The deliberate gentle fallbacks are dead.** Because the global rule is `!important`, these per-component reduced-motion rules, which were written to keep opacity feedback, are overridden:
   - `globals.css:922-927`: schedule roster falls back to `animation: schedRosterFade 140ms ease-out` (opacity only).
   - `globals.css:1014-1016`: `.sched-click-flash { animation-duration: 200ms; }`, whose comment at 1006-1007 says "Kept under reduced-motion (shorter) — it's a state-change confirmation, not decoration."
   - `globals.css:991-994`: the beacon's reduced-motion fade.

Reduced motion should mean fewer and gentler animations, not zero: keep opacity and color feedback, drop movement.

## Target

Keep the global clamp (it is the safety net for the long tail), and add an explicit allowlist right after it, inside the same media query, that restores what should survive. Class selectors with `!important` beat the universal selector's `!important` on specificity.

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }

  /* Survives reduced motion: loading indicators (a frozen spinner reads as
     stuck) and the opacity-only fallbacks components opted into below. */
  .animate-spin {
    animation-duration: 1s !important;
    animation-iteration-count: infinite !important;
  }
  .app-loader-bar::after {
    animation-duration: 1.5s !important;
    animation-iteration-count: infinite !important;
  }
  .sched-click-flash {
    animation-duration: 200ms !important;
  }
}
```

Then fix the two opacity-only fallbacks so they carry their own duration with `!important`:
- `globals.css:922-927`: change `animation: schedRosterFade 140ms ease-out;` to `animation: schedRosterFade 140ms ease-out !important;`
- `globals.css:991-995`: change `animation: schedRosterFade 140ms ease-out 250ms backwards;` (on `.cc-session-beacon, .cc-session-beacon[data-dir="up"]`) to `animation: schedRosterFade 140ms ease-out 250ms backwards !important;`. Leave `.cc-session-beacon__dot { animation: none; }` as is.

## Repo conventions to follow

- `.search-scan-bar` (globals.css:6175-6177) is the right pattern for an infinite sweep under reduced motion: stop the movement, keep a static opacity (`animation: none; opacity: 0.5;`). Leave it as is.
- Comments in this file explain WHY a rule exists, in full sentences. Match that.

## Steps

1. Replace `packages/web/app/globals.css:805-814` with the target block above (the global clamp unchanged plus the allowlist).
2. Edit `globals.css:922-927` as described.
3. Edit `globals.css:991-995` (the beacon) as described.
4. Do not touch the ~35 per-component `animation: none` blocks elsewhere. They are redundant but harmless.

## Boundaries

- Do NOT remove the global clamp.
- Do NOT add `motion-reduce:` classes across tsx files.
- Do NOT restore any animation that translates or scales an element (entrances, slides, pops). Rotation of `.animate-spin` in place is the only transform allowed back.
- If line numbers drift, locate the rules by their selectors; if a selector is missing, STOP and report.

## Verification

- **Mechanical**: `cast check web` reports 0 errors.
- **Feel check**: DevTools, Rendering panel, "Emulate CSS media feature prefers-reduced-motion: reduce", then:
  - Trigger any loading state with a spinner (e.g. a slow search, the app loader on reload): the spinner rotates continuously.
  - Open the schedules roster from the dock: it fades in over ~140ms with no upward slide.
  - Click a schedule row: the orange wash fades over ~200ms.
  - Open a popover, a dialog, send a message: none of them slide or scale (still clamped).
  - Turn the emulation off: everything behaves as before this change.
- **Done when**: all five checks hold.
