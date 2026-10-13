import { AppLoader } from "./AppLoader";
import { isTransparentWindow } from "../lib/desktop";
import { modePageLabel, useHostedMode } from "../lib/surfaces";

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
export function RouteFallback({ screen = false, path }: { screen?: boolean; path?: string }) {
  const hosted = useHostedMode();
  if (isTransparentWindow()) return null;
  // Inside the shell, a hosted page that has a name (To-dos, Notes, Routines,
  // Approvals) holds its own header in place while its chunk loads, so the
  // person sees the page they asked for rather than the brand splash.
  const title = !screen && hosted && path ? modePageLabel(path, true) : null;
  if (title) return <PageSkeleton title={title} />;
  return <AppLoader className={screen ? undefined : "min-h-0 h-full bg-transparent"} deferIndicator />;
}

/** A list page's header and a few muted rows, in the page's own place. */
function PageSkeleton({ title }: { title: string }) {
  return (
    <div data-cc-page-skeleton aria-busy="true" className="mx-auto w-full max-w-3xl px-6 pt-6">
      <h1 className="mb-5 text-[22px] font-medium text-sol-text" style={{ fontFamily: "var(--pd-font-read)" }}>{title}</h1>
      {[72, 56, 64].map((w) => (
        <div key={w} className="flex h-[41px] items-center gap-3 px-1">
          <span className="h-3.5 w-3.5 rounded-full bg-sol-bg-highlight" />
          <span className="h-3 rounded bg-sol-bg-highlight" style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}
