// The stage of an app's page: the app's frame and the column it fills. It
// is drawn from the link alone, so the app starts loading on first paint and
// keeps loading while the page learns what the app is and who you are. The
// room (AppPage's AppRoom) takes it over once both are known: it says what
// the frame shows and how much of the page the column leaves to the panel
// and the dock (useStage), and draws its own parts over the app and in the
// column through portals into them.
import { createContext, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { AppFrame, type AppFrameProps } from "./AppFrame";
import { StuckNote } from "./StuckNote";
import s from "./AppPage.module.css";

export type StageControl = {
  frame: Omit<AppFrameProps, "slug">;
  /** Width the room's panel takes from the right. */
  right: number;
  /** Height the dock takes from the bottom. */
  bottom: number;
};

/** Where the room draws: over the app, and in its column. */
type Slots = { area: HTMLDivElement | null; col: HTMLElement | null };

const StageContext = createContext<(Slots & { take: (control: StageControl) => void }) | null>(null);

/** `onStuck`: while the visitor is not known yet, the way to try again,
 *  offered once that takes a while. */
export function Stage({ slug, version, onStuck, children }: { slug: string; version: number | null; onStuck: (() => void) | null; children: ReactNode }) {
  // Until the room takes over, the frame stays on where it started.
  const [first] = useState(version);
  const [control, take] = useState<StageControl | null>(null);
  const [area, setArea] = useState<HTMLDivElement | null>(null);
  const [col, setCol] = useState<HTMLElement | null>(null);
  const stage = useMemo(() => ({ area, col, take }), [area, col]);
  const frame = control?.frame ?? { version: first, live: null, session: null };
  return (
    <StageContext.Provider value={stage}>
      <div className={s.page}>
        <main ref={setCol} className={s.appCol} style={{ right: control?.right ?? 0 }}>
          <div ref={setArea} className={s.appArea} style={{ bottom: control?.bottom ?? 0 }}>
            <AppFrame slug={slug} {...frame} />
            {onStuck && <StuckNote onRetry={onStuck} className={s.stuck} />}
          </div>
        </main>
        {children}
      </div>
    </StageContext.Provider>
  );
}

/** Take the stage over with `control` (keep it memoized: each new one
 *  redraws the frame), and get the slots to draw into. */
export function useStage(control: StageControl): Slots {
  const stage = useContext(StageContext);
  if (!stage) throw new Error("useStage outside Stage");
  const { take } = stage;
  useLayoutEffect(() => take(control), [take, control]);
  return stage;
}
