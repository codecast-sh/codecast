// The family's three faces, bundled (fontsource), so an app paints them from
// its own origin with no third party request. Import it once, for its side
// effect, beside tokens.css: FONTS names these "Variable" families first.
// Each import names its .css file: vite's dev optimizer pre-bundles this
// module, and drops a CSS import that resolves only through a package entry.
import "@fontsource-variable/instrument-sans/index.css";
import "@fontsource-variable/newsreader/index.css";
import "@fontsource-variable/newsreader/wght-italic.css";
import "@fontsource/fragment-mono/index.css";
