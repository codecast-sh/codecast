# My project

User prose that lives ABOVE every codecast block. An install must leave this
byte-identical.

## Messaging

STALE MESSAGING BODY — a short stand-in for whatever an older CLI wrote here.
Installing the `messaging` snippet must replace this block rather than stack a
second copy under it.
<!-- /codecast-messaging -->

## House rules

A user's own section sitting BETWEEN two codecast blocks. Nothing may move it.

## Referencing objects

STALE REFERENCES BODY — the shared section that ten of the eleven snippets
refresh as a side effect of installing. The one that does not (`visual`) leaves
this text exactly as it stands.
<!-- /codecast-references -->

## Deploy notes

The last user section. It follows the codecast blocks, so anything that cuts a
block by "everything to end of file" destroys this paragraph.

## Visual Canvas

When structure or magnitude carries the meaning (comparisons, flows, timelines, metrics, dashboards), make a `cast-canvas` block of self-contained HTML/CSS/SVG the centerpiece of the reply, or of a `cast decide` context, where the human weighs options and a comparison they can see beats one they must assemble from prose; codecast renders it inline, themed, expandable to fullscreen. Keep markdown for ordinary prose.

```cast-canvas
<div data-canvas-title="Shown in the header"> … </div>
```

**Theme with `--sol-*` tokens; never hardcode colors.** Text `--sol-text/-text-muted/-text-dim` · surfaces `--sol-card/-bg-alt/-border` · accents `--sol-blue/green/yellow/red/magenta/cyan/orange/violet` · soft fill `color-mix(in srgb, var(--sol-blue) 14%, transparent)`. Full CSS and SVG work: grid/flex, gradients, `<defs>`+`<use>`, animations, hover states, `<details>`. Compose like a report: title, one-line takeaway, panels. `data-canvas-size="wide"` on the root uses the full screen width.

**Sandboxed: no scripts, no network**; third-party images and fonts are stripped. Upload any image first (a screenshot, a local file, a remote URL):

```bash
cast image shot.png            # or a URL; prints a stable https URL + ready markdown (--alt "30-day overview" sets the caption)
```

That URL renders everywhere: `![alt](url)` in a reply or message, `<img src="url">` in a canvas. The alt text is the caption, so write a real one. Images in one paragraph sit side by side, so `![before](u1) ![after](u2)` reads as a comparison. Never link local paths (`/tmp/…`, `/var/folders/…`); the human's browser cannot read them. `data:` URIs work in a canvas but bloat the message.

Declarative interactivity:

- Tabs: `<div class="cast-tabs"><section data-tab="Label">…</section>…</div>`
- Sortable table: `<table class="cast-table">`
- Tooltip: `data-tip="text"` on any element
- Chart: `<div class="cast-chart" data-spec='{"marks":[{"type":"barY","data":[…],"x":"label","y":"value"}],"y":{"grid":true}}'></div>`

**Charts take every Observable Plot mark and transform by name**, so fit the form to the data: `dot`, `boxY`, `density`, `cell` heatmaps, stacked `areaY`, `arrow`, `vector`, and on. Multi-series: `fill`/`stroke` as a field plus `"color":{"legend":true}`; facet with `fx`/`fy`; aggregate with transforms (`"transform":{"kind":"binX","out":{"y":"count"}}`, likewise `groupX`, `hexbin`, `dodgeX`, `windowY`) rather than pre-summing.
<!-- cast @VERSION@ -->
<!-- /codecast-visual -->
