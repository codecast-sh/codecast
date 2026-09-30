# Animation plans

Written by the improve-animations audit on 2026-09-30 at commit 3efe31bb3. Each plan is self-contained; run them in any order unless noted.

| Plan | Title | Severity | Status |
|---|---|---|---|
| [001](001-instant-keyboard-selection.md) | Make keyboard-driven selection instant | HIGH | TODO |
| [002](002-chunk-hint-pop-bug.md) | Stop the chunk hint jumping when it appears | HIGH | TODO |
| [003](003-stage-morph-invalid-transition.md) | Repair the stage split morph (invalid transition) | HIGH | TODO |
| [004](004-reduced-motion-gentler-not-zero.md) | Reduced motion: keep spinners and gentle fallbacks | HIGH | TODO |
| [005](005-transition-all-hot-surfaces.md) | Replace transition-all on the message list and composer | MEDIUM | TODO |

## Order

002 and 003 are one-line bug fixes: do them first. 001 and 005 both edit className strings but touch different files. 004 is independent.

## Not yet planned (from the same audit)

- Easing and duration tokens: 19 distinct cubic-beziers (five near-identical ease-outs), ~45 distinct durations, and `--cc-panel-motion` defined twice (globals.css:454 and :3404). Consolidate into `--ease-out`, `--ease-in-out`, `--ease-drawer` plus a duration scale.
- Duplicate fade-up keyframes (fadeIn, fadeSlideIn defined in both CSS and tailwind.config, messageSlideIn, ccFade, ...) and four copies of the "attention flash".
- Over-large scale entrances: viewers.css:36 (0.6), DeviceShareControl.tsx:81 (zoom-in-50), UnreadCount.tsx:10 and CallChatChip.tsx:19 (zoom-in-75, re-fired by `key`), faceRow.css:343 (0.4).
- Infinite box-shadow pulses (ccPulse, face-ring-ripple, and others) and N live `animate-ping` dots that only pause in the desktop app.
- sheet.tsx:32 defaults to 500ms ease-in-out (the only consumer, MobileDrawer, overrides the durations).
- editor.css:502 `ease-in` on the collaborator cursor label.
