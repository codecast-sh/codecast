# Browser verification

Published URL: https://codecast.sh/a/d0vFfz4flyqj

## Final version 3 confirmation

On 5 September 2026, coordinator jx70p9m reported that version 3 was published, opened and DOM-verified: ten chapters, nine focusable pre blocks, zero generic labels and zero horizontal overflow. This resolves the final publication blocker. This confirmation is attributed to the coordinator; the detailed checks below were performed in this session on version 2.

## Version 2 verification history

The public URL was opened in the session-owned browser tab B2408832, then inspected and captured. No extra verification tabs were opened. The codecast extension was disconnected, so a clone was used for this public page. Browser helper commands became unreliable under host load; the final focused checks used the same owned tab through CDP, not a new browser instance.

## Confirmed

- Ten chapters, seven HTML figures/interface concepts, 24 tables, and all internal fragment targets.
- Font loading completed on the published page.
- Local CSS viewport/document width: 320/320, 390/390 and 1440/1440.
- Published browser at its current zoom: 312/312 and 1152/1152 CSS pixels, no document overflow. Physical device metrics were 390px and 1440px.
- Contents opens; chapter 7 navigation resolves with its heading 93.875px below the viewport top. Expanded mobile contents is non-sticky, so it does not cover the target.
- Enter on the focused native organization summary closes it. A visible focus outline remains.
- Evidence disclosure opens and displays the checked revision and limitations.
- Reduced-motion emulation disables reveal animation and uses immediate scrolling.
- Print-media emulation hides the rail and wraps code. A PDF was not produced or claimed tested.
- Published desktop and narrow decision screenshots were viewed, not merely captured.

## Accessibility scope

Axe-core 4.12.1 returned zero automatic violations and 33 passing rule groups for the proposal main landmark. It also returned manual-review items: 9 aria-prohibited-attr nodes and 292 color-contrast nodes. This is not a claim of complete accessibility certification.

The ARIA review identified unnecessary labels on generic preformatted code blocks. The local builder now removes those labels while retaining keyboard focusability. At the time of this audit, the newly restricted sandbox blocked publication of the metadata-only correction at CLI daemon.pid cleanup. The coordinator subsequently published and checked the correction in version 3, as recorded above.

Contrast pairs were checked numerically from the final solid-color palette; each tested ordinary-text pair exceeds 4.5:1. Offscreen cells inside horizontal scroll regions account for many automatic incomplete checks. Scroll regions remain keyboard accessible; color checks and screenshots complement, rather than replace, the automated audit.

Initial audit findings drove real fixes: unique region names, focusable code, and removal of a background gradient. Initial mobile overflow was reproduced at 777px document width for a 390px viewport and corrected to 390px.

## Reproduction and limits

Raw browser results and representative captures accompany this record. External fonts have serif/monospace fallback stacks. The page itself contains no authored JavaScript. The published host adds its own viewer controls; this check does not certify all host controls.

A full application gate was attempted and did not pass; see repository-gates.md. Planned feature tests in chapter 8 were not run against an implementation because no organization feature was implemented.
