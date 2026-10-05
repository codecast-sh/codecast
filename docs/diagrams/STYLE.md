# Diagram style

Diagrams in `docs/` are hand-written SVG files in this directory, embedded from
markdown with a relative path: `![What the diagram shows](../diagrams/name.svg)`.
They render on GitHub, in editors and on codecast.sh, and they diff like code, so
fix a stale diagram by editing its source.

`system-overview.svg` is the reference. Copy its `<style>` block and follow it.

## Rules

- **One idea per diagram.** If a caption needs two sentences, split the drawing.
- **Draw only what the code does.** Name real modules, tables and commands, and
  check each one against the tree before drawing it.
- **Palette** is the app's Solarized tokens, written as hex because an SVG loaded
  through `<img>` cannot read the page's CSS variables. The `<style>` block
  switches to the dark palette under `prefers-color-scheme: dark`, so the drawing
  reads on GitHub's dark theme too.
  - surfaces: page `#FBF5E2`, card `#ffffff`, inset `#eee8d5`, border `#93a1a1`
  - text: `#002b36`, muted `#586e75`, dim `#93a1a1`
  - accents, one meaning each per diagram: cyan `#2aa198` (data flow), blue
    `#268bd2` (control and commands), orange `#cb4b16` (the human), green
    `#859900` (success, done), violet `#6c71c4` (agents), yellow `#b58900` (waiting)
- **Type**: `JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace`.
  Titles 15px semibold, labels 12px, notes 11px muted. Remote fonts do not load
  inside an `<img>`, so the fallbacks carry it on most machines.
- **Shapes**: rounded rects (`rx="8"`), 1.25px strokes, arrowheads from one
  `<marker>` per color. Solid arrows move data, dashed arrows send commands.
- **Size**: a `viewBox` about 960 wide, no fixed `width`/`height`, so it scales
  to the column. Leave 24px of margin.
- **Accessibility**: a `<title>` and `<desc>` in every file, and alt text in the
  markdown that says what the drawing shows.
- No embedded raster images, scripts or external references.
