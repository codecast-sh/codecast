import { AppLoader } from "./AppLoader";
import { isTransparentWindow } from "../lib/desktop";

/**
 * What a route host shows while a lazy page's chunk is still loading: the app
 * loader filling the host. The mark is delayed so a warm chunk never flashes
 * it; a cold or stalled fetch shows a holding state instead of an empty pane.
 *
 * `screen` is for the app's top-level host. Nothing above it has a height
 * (#root, body and html are all auto), so filling the host there resolves to
 * zero and the loader sat at the very top of the page, half above it. The
 * full-screen form is the same geometry as index.html's #boot-shell, which
 * hides the moment this mounts, so the hand-off stays invisible.
 *
 * A see-through desktop window (palette, dock, rings) shows nothing: a loader
 * there is a card floating over somebody's work for no reason.
 */
export function RouteFallback({ screen = false }: { screen?: boolean }) {
  if (isTransparentWindow()) return null;
  return <AppLoader className={screen ? undefined : "min-h-0 h-full bg-transparent"} deferIndicator />;
}
