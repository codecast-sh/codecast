# @platform/design

The family's design tokens, shared by Whisk and codecast's simple lane so the
two read as one product while each stays a complete app.

- `src/tokens.ts` is the one home of every value: `PALETTE` (light and dark),
  `FONTS`, `FONTS_HREF`, `SHAPE`, `MOTION`. Native apps read these directly.
- `tokens.css` is generated from it (`bun run build`) as `--pd-*` custom
  properties on `:root`, with the dark palette under
  `:root[data-theme="dark"], :root.dark`. Import it once:
  `import "@platform/design/tokens.css"`.
- Each app maps its own names onto `--pd-*` and keeps its own metrics. Put a
  value here only when every app means the same thing by it.
