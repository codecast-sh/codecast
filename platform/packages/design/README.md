# @platform/design

The family's design tokens, shared by Whisk and codecast's simple lane so the
two read as one product while each stays a complete app.

- `src/tokens.ts` is the one home of every value: `PALETTE` (light and dark),
  `FONTS`, `SHAPE`, `MOTION`. Native apps read these directly.
- `tokens.css` is generated from it (`bun run build`) as `--pd-*` custom
  properties on `:root`, with the dark palette under
  `:root[data-theme="dark"], :root.dark`. Import it once:
  `import "@platform/design/tokens.css"`.
- Each app maps its own names onto `--pd-*` and keeps its own metrics. Put a
  value here only when every app means the same thing by it.
- `@platform/design/vite` exports `designTokens()`, a vite plugin that puts
  the sheet in every HTML entry's `<head>`, so the first paint and any script
  in `<body>` see the family's values before a bundle loads
  (`tokensStyleTag()` is the tag alone, for a plugin of the app's own).
- `@platform/design/fonts` loads the three faces from the app's own bundle
  (fontsource), the names `FONTS` puts first. Import it once, beside the
  sheet.
