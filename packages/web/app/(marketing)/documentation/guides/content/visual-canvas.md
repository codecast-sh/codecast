The visual canvas lets an agent answer with a designed page instead of a wall of text. When structure or magnitude carries the meaning — comparisons, flows, timelines, metrics, dashboards — the agent emits a `cast-canvas` block of self-contained HTML, CSS, and SVG, and codecast renders it inline in the conversation: themed to match the app, expandable to fullscreen.

The visual snippet teaches agents the format and, just as important, the restraint: reach for a canvas when a visual beats prose; the default stays markdown. It is installed via [the snippet system](/documentation/agent-snippets).

## The format

A canvas is a fenced block:

````
```cast-canvas
<div data-canvas-title="Shown in the header">
  …HTML/CSS/SVG…
</div>
```
````

`data-canvas-title` names the block in its header; `data-canvas-size="wide"` on the root lets a dashboard take the full screen width.

## Sandboxed by design

Canvas HTML runs with no scripts and no network. Remote images and fonts are stripped — images must be inline `data:` URIs, and the canvas inherits codecast's mono font. This is what makes it safe to render agent-authored HTML inside the app: the block can lay out anything, but it cannot phone home, run code, or read anything outside itself.

Theming rides on CSS variables. The snippet instructs agents to color everything with the `--sol-*` tokens — `--sol-text`, `--sol-card`, `--sol-border`, and the eight accents — and never hardcode colors, so a canvas follows the app's light and dark themes automatically.

## Declarative interactivity

Because scripts are stripped, interactivity is declarative: the agent writes a class or attribute, codecast supplies the behavior.

- **Tabs**: `<div class="cast-tabs"><section data-tab="Label">…</section>…</div>`
- **Sortable table**: `<table class="cast-table">` — headers become click-to-sort
- **Tooltips**: `data-tip="text"` on any element
- **Charts**: a `cast-chart` div with a JSON spec

```html
<div class="cast-chart" data-spec='{
  "marks": [{"type":"barY","data":[…],"x":"label","y":"value"}],
  "y": {"grid": true}
}'></div>
```

Charts compile to Observable Plot, and the whole mark and transform vocabulary is available by name: `dot`, `boxY`, `density`, `cell` heatmaps, stacked `areaY`, `arrow`, `vector`, and the rest. Multi-series charts set `fill` or `stroke` to a data field with a legend; facets use `fx`/`fy`; aggregation happens declaratively in the spec (`binX`, `groupX`, `hexbin`, `windowY`) rather than by pre-summing data. The agent describes the data and the form; codecast renders it themed.

## Where canvases show up

Anywhere conversations render: the web dashboard, the desktop app, and mobile. A canvas is part of the message, so it survives in the transcript, shows up in shared links, and appears wherever the session is read later.

For deliverables that should live outside a conversation — a report a stakeholder opens by URL — use [published pages](/documentation/publish) instead: same authoring skills, but a standalone page with a stable link, version history, and access gates.
