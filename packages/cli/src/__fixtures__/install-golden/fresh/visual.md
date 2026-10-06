
## Visual Canvas

When structure or magnitude carries the meaning (comparisons, flows, timelines, metrics, dashboards), make a `cast-canvas` block of self-contained HTML/CSS/SVG the centerpiece of the reply, or of a `cast decide` context. Codecast renders it inline, themed, expandable to fullscreen. Keep markdown for ordinary prose, and let the prose around a visual add only what the picture does not say.

```cast-canvas
<div data-canvas-title="Shown in the header"> … </div>
```

**Theme with `--sol-*` tokens; never hardcode colors.** Text `--sol-text/-text-muted/-text-dim` · surfaces `--sol-card/-bg-alt/-border` · accents `--sol-blue/green/yellow/red/magenta/cyan/orange/violet` · soft fill `color-mix(in srgb, var(--sol-blue) 14%, transparent)`. Compose like a report: title, one-line takeaway, panels.

**Sandboxed: no scripts, no network**; third-party images and fonts are stripped. Upload an image first with `cast image <file-or-url>`, which prints a stable URL for `<img src>` or `![alt](url)`. Never link local paths (`/tmp/…`); the human's browser cannot read them.

Built in: tabs (`<div class="cast-tabs"><section data-tab="Label">…</section></div>`), sortable tables (`<table class="cast-table">`), tooltips (`data-tip="text"`), and charts (`<div class="cast-chart" data-spec='{"marks":[{"type":"barY","data":[…],"x":"label","y":"value"}]}'></div>`, any Observable Plot mark or transform by name).

When the reader should explore (zoom, drill in, hover thousands of points), publish a page with its own script instead (`cast publish`) and put its URL alone on a line. `cast guide visual` covers images, charts and pages in detail.
<!-- cast @VERSION@ -->
<!-- /codecast-visual -->
