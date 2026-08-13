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

When structure or magnitude carries the meaning — comparisons, flows, timelines, metrics, dashboards — emit a `cast-canvas` block of self-contained HTML/CSS/SVG. Codecast renders it inline, themed, expandable to fullscreen. Let the canvas be the centerpiece of such a reply, and keep markdown for ordinary prose.

```cast-canvas
<div data-canvas-title="Shown in the header"> … </div>
```

**Theme with `--sol-*` tokens; never hardcode colors.** Text `--sol-text/-text-muted/-text-dim` · surfaces `--sol-card/-bg-alt/-border` · accents `--sol-blue/green/yellow/red/magenta/cyan/orange/violet` · soft fill `color-mix(in srgb, var(--sol-blue) 14%, transparent)`. Full CSS and SVG: grid/flex panels, gradients, `<defs>`+`<use>`, CSS animations/transitions, hover states, `<details>`. Compose like a considered report: title, one-line takeaway, then panels. `data-canvas-size="wide"` on the root lets a dashboard use the full screen width.

**Sandboxed: no scripts, no network.** Third-party remote images and fonts are stripped. To show an image — a screenshot you took, a local file, a remote image — upload it first:

```bash
cast image shot.png            # or a URL: cast image https://…/diagram.png
# → prints a stable https URL + ready markdown ![shot](url)
```

That URL renders inline for the human everywhere: `![alt](url)` in any reply or message, `<img src="url">` inside a canvas. The alt text renders as a caption — write a real one (`--alt "30-day overview"`). Several images in one paragraph render side by side, so `![before](u1) ![after](u2)` reads as a comparison row. Never link local file paths (`/tmp/…`, `/var/folders/…`) — the human's browser cannot read files on this machine, so those links are dead. `data:` URIs also work in a canvas but bloat the message; prefer `cast image`.

Interactivity is declarative; codecast supplies the behavior:

- Tabs: `<div class="cast-tabs"><section data-tab="Label">…</section>…</div>`
- Sortable table: `<table class="cast-table">` — headers become click-to-sort
- Tooltip: `data-tip="text"` on any element
- Chart: `<div class="cast-chart" data-spec='{"marks":[{"type":"barY","data":[…],"x":"label","y":"value"}],"y":{"grid":true}}'></div>`

**Charts get every Observable Plot mark and transform by name** — fit the form to the data: `dot`, `boxY`, `density`, `cell` heatmaps, stacked `areaY`, `arrow`, `vector`, and on. Multi-series: `fill`/`stroke` as a field plus `"color":{"legend":true}`; facet with `fx`/`fy`; aggregate declaratively — `"transform":{"kind":"binX","out":{"y":"count"}}`, likewise `groupX`, `hexbin`, `dodgeX`, `windowY` — rather than pre-summing.
<!-- /codecast-visual -->
