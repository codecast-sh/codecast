The visual canvas lets an agent answer with a designed page instead of a wall of text. When structure or magnitude carries the meaning (comparisons, flows, timelines, metrics, dashboards), the agent emits a `cast-canvas` block of self-contained HTML, CSS, and SVG, and codecast renders it inline in the conversation: themed to match the app, expandable to fullscreen. The same block renders in a `cast decide` context, so a decision in the queue can open with its options laid side by side instead of described in paragraphs.

Everything in the figure below is live. Each example is a real canvas rendered by the same component the app uses in a conversation, and the theme row switches the classes the app puts on the page. Nothing in the canvas source changes between themes.

```figure
CanvasThemesFigure
Four canvases, four themes, one source each. Pick an example or a theme; the swatches are the tokens the canvas reads.
```

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

`data-canvas-title` names the block in its header; `data-canvas-size="wide"` on the root lets a dashboard take the full screen width. The header also carries a source toggle, a copy button, and fullscreen. A canvas taller than 620 pixels folds behind a "Show all" control so it never swallows the conversation.

## How a canvas matches the theme

Theming rides on CSS variables. The snippet instructs agents to color everything with the `--sol-*` tokens (`--sol-text`, `--sol-card`, `--sol-border`, and the eight accents) and never hardcode colors. A token names a role, not a color: `--sol-red` is "the bad number", and each theme decides what that looks like. Solarized dark keeps the accents and inverts the surfaces; the minimal themes swap in their own quieter accents.

```figure
TokenAnatomyFigure
The agent writes roles. Each of the app's four themes resolves them to its own colors.
```

The tokens reach the canvas because it renders into a shadow root rather than an iframe. CSS custom properties inherit through the shadow boundary, so the canvas reads the live theme with no setup and follows a theme switch the moment it happens. The shadow root also works the other way: the canvas's own `<style>` stays scoped inside it, so an agent's `.card { … }` cannot restyle the app around it, and the app's prose styles cannot distort the canvas.

For a soft fill, mix a token with transparency rather than inventing a lighter shade: `color-mix(in srgb, var(--sol-blue) 14%, transparent)` stays correct on light and dark backgrounds alike.

## Sandboxed by design

Canvas HTML runs with no scripts and no third-party network. Before it mounts, the block goes through a sanitizer that removes scripts, event handlers, iframes, forms and embeds, drops any image that is not an inline `data:` URI or a codecast-hosted image, and rewrites remote `url()` references in CSS to `none`. Links open in a new tab, except links to codecast's own objects, which navigate inside the app.

```figure
SandboxPipelineFigure
Sanitize, mount in a shadow root that inherits the theme, then hydrate. The interactive parts are codecast's code, never the agent's.
```

This is what makes it safe to render agent-authored HTML inside the app. Conversations sync across a team, so a canvas is untrusted content shown to people who did not write it: the block can lay out anything, but it cannot phone home, run code, or read anything outside itself.

## Declarative interactivity

Because scripts are stripped, interactivity is declarative: the agent writes a class or attribute, codecast supplies the behavior.

- **Tabs**: `<div class="cast-tabs"><section data-tab="Label">…</section>…</div>`
- **Sortable table**: `<table class="cast-table">`, whose headers become click to sort (try the "Sortable table" example above)
- **Tooltips**: `data-tip="text"` on any element (hover "deliver" in the "Flow" example)
- **Charts**: a `cast-chart` div with a JSON spec

```html
<div class="cast-chart" data-spec='{
  "marks": [{"type":"barY","data":[…],"x":"label","y":"value"}],
  "y": {"grid": true}
}'></div>
```

Charts compile to Observable Plot, and the whole mark and transform vocabulary is available by name: `dot`, `boxY`, `density`, `cell` heatmaps, stacked `areaY`, `arrow`, `vector`, and the rest. Multi-series charts set `fill` or `stroke` to a data field with a legend; facets use `fx`/`fy`; aggregation happens declaratively in the spec (`binX`, `groupX`, `hexbin`, `windowY`) rather than by pre-summing data. The agent describes the data and the form; codecast renders it in the canvas's mono font with the theme's colors. Plot loads only when a chart appears, so a canvas without one costs nothing extra.

## Screenshots and images

Agents constantly have images worth showing: a screenshot of the UI they just built, a chart they rendered, a diagram from the web. A link to a local file path is dead in your browser, so the snippet teaches `cast image` instead:

```bash
cast image shot.png                    # local file
cast image https://…/diagram.png       # remote image, re-hosted
```

The command uploads the image to codecast's storage and prints a stable URL plus ready-to-paste markdown. That URL renders inline, with no click-to-load gate, in message markdown (`![alt](url)`) and inside a canvas (`<img src="url">`), for you and for teammates reading the session. Arbitrary third-party image URLs stay gated behind a click, because an auto-fetching remote image is a tracking pixel.

## Where canvases show up

Anywhere conversations render: the web dashboard, the desktop app, and mobile. A canvas is part of the message, so it survives in the transcript, shows up in shared links, and appears wherever the session is read later.

For deliverables that should live outside a conversation, such as a report a stakeholder opens by URL, or a view a reader should explore with zooming and scripted interaction, use [published pages](/documentation/publish) instead: the same `--sol-*` tokens are injected into every published page, but the page can run its own code and lives at a stable link with version history and access gates.
