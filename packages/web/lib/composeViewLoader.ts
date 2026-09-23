// The compose view's module, loaded once and then held directly.
//
// A React.lazy component suspends on its first render even when its module is
// already loaded (the import promise settles a microtask later), so the first
// Ctrl+N committed the backdrop with an empty Suspense fallback, and React
// throttles the reveal that replaces a fallback to 300ms after it appeared.
// Rendering the held component skips Suspense entirely; the lazy wrapper is
// only for an open that beats the idle warm-up in boot.tsx, and once it has
// rendered it stays: swapping the element type under an open composer would
// remount it and drop the draft.
import { lazy } from "react";
import type { ComposeView as ComposeViewType } from "../components/ComposeView";

let loaded: typeof ComposeViewType | null = null;
let loading: Promise<typeof ComposeViewType> | null = null;
let lazyRendered = false;

export function loadComposeView(): Promise<typeof ComposeViewType> {
  // A failed warm-up must not become the open's answer: forget it, so the key
  // press imports again.
  loading ??= import("../components/ComposeView").then(
    (module) => (loaded = module.ComposeView),
    (error) => { loading = null; throw error; },
  );
  return loading;
}

const LazyComposeView = lazy(() => loadComposeView().then((ComposeView) => ({ default: ComposeView })));

export function composeViewComponent(): typeof ComposeViewType | typeof LazyComposeView {
  if (loaded && !lazyRendered) return loaded;
  lazyRendered = true;
  return LazyComposeView;
}
