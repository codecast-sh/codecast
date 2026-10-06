
## Visual Canvas

When structure or magnitude carries the meaning (comparisons, flows, timelines, metrics, dashboards), make a `cast-canvas` block of self-contained HTML/CSS/SVG the centerpiece of the reply, or of a `cast decide` context, where the human weighs options and a comparison they can see beats one they must assemble from prose; codecast renders it inline, themed, expandable to fullscreen. Keep markdown for ordinary prose. The reader already sees the visual, so the prose around it adds only what the picture does not say.

```cast-canvas
<div data-canvas-title="Shown in the header"> … </div>
```

**Theme with `--sol-*` tokens; never hardcode colors.** Text `--sol-text/-text-muted/-text-dim` · surfaces `--sol-card/-bg-alt/-border` · accents `--sol-blue/green/yellow/red/magenta/cyan/orange/violet` · soft fill `color-mix(in srgb, var(--sol-blue) 14%, transparent)`. Full CSS and SVG work: grid/flex, gradients, `<defs>`+`<use>`, animations, hover states, `<details>`. Compose like a report: title, one-line takeaway, panels. `data-canvas-size="wide"` on the root uses the full screen width.

**Sandboxed: no scripts, no network**; third-party images and fonts are stripped. Upload any image first (a screenshot, a local file, a remote URL):

```bash
cast image shot.png            # or a URL; prints a stable https URL + ready markdown (--alt "30-day overview" sets the caption)
```

That URL renders everywhere: `![alt](url)` in a reply or message, `<img src="url">` in a canvas. The alt text is the caption, so write a real one. An image shows small and folds past a short height, which suits most screenshots; when its detail is the point, add a title: `![alt](url "wide")` spans the column and shows the whole image, `"small"` makes a thumbnail. Images in one paragraph sit side by side, so `![before](u1) ![after](u2)` reads as a comparison. Never link local paths (`/tmp/…`, `/var/folders/…`); the human's browser cannot read them. `data:` URIs work in a canvas but bloat the message.

Declarative interactivity:

- Tabs: `<div class="cast-tabs"><section data-tab="Label">…</section>…</div>`
- Sortable table: `<table class="cast-table">`
- Tooltip: `data-tip="text"` on any element
- Chart: `<div class="cast-chart" data-spec='{"marks":[{"type":"barY","data":[…],"x":"label","y":"value"}],"y":{"grid":true}}'></div>`

**Charts take every Observable Plot mark and transform by name**, so fit the form to the data: `dot`, `boxY`, `density`, `cell` heatmaps, stacked `areaY`, `arrow`, `vector`, and on. Multi-series: `fill`/`stroke` as a field plus `"color":{"legend":true}`; facet with `fx`/`fy`; aggregate with transforms (`"transform":{"kind":"binX","out":{"y":"count"}}`, likewise `groupX`, `hexbin`, `dodgeX`, `windowY`) rather than pre-summing. `"tip":true` on a mark shows each value on hover.

**When the reader should explore, publish a page instead.** A canvas runs no code, so zooming, drilling into a treemap, switching what a view measures, or hovering across thousands of points belong in a self-contained HTML page with its own script (a CDN library such as D3 is fine) and its data inline. Style it with the same `--sol-*` tokens: codecast injects them into every published page and keeps them on the reader's palette, light or dark. Use a fluid width and fixed pixel heights so the frame can fit the page. `cast publish page.html`, then put the URL alone on its line: it embeds live in the reply at the page's height. Look at it before you reply (`cast browser open <url>`, `shot`, `errors`) and republish until it is right. A published page is open to anyone holding the link, so gate sensitive data with `--password`.
<!-- cast @VERSION@ -->
<!-- /codecast-visual -->
