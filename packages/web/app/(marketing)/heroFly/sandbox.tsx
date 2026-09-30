"use client";

/**
 * The wall between the hero's fixtures and the visitor's app. Real product
 * views render inside it with fixture props only; every channel a view could
 * still reach is answered here instead of by the real app:
 *
 *   Convex        a stub client: queries load forever, writes resolve null
 *   entity pills  answered from the chapters' fixtures, no query, no store read
 *   personify     off, whatever the visitor chose
 *   theme         light Classic (tokens are also re-declared on .hero-sandbox)
 *   reveal bands  reported as already inside one, so none mounts a real pane
 *   navigation    link clicks cancelled; clicks, presses and keys stop here
 *                 unless the target sits inside a `data-hero-live` element
 *   drag, drop, context menus   cancelled
 *   errors        caught here, reported without a toast
 *
 * The mount policy in ARCHITECTURE.md lists the containers that must never
 * render in here; sandbox.guard.test.tsx proves the isolation.
 */

import type { ReactNode, SyntheticEvent } from "react";
import { ConvexProvider } from "convex/react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ThemeContext } from "@/components/ThemeProvider";
import { PersonifyOverride } from "@/hooks/usePersonifyAll";
import { EntityFixtureContext } from "@/lib/entityDisplay";
import { RevealInBandCtx } from "@/lib/revealHost";
import { heroConvexStub } from "./convexStub";
import { HERO_ENTITIES } from "./fixtures";

const noop = () => {};
const HERO_THEME = { theme: "light" as const, toggleTheme: noop, visualStyle: "classic" as const, setVisualStyle: noop };

/** Links never navigate; anything outside a `data-hero-live` element never reaches the real handler under it. */
function cancelNav(e: SyntheticEvent) {
  const target = e.target;
  if (!(target instanceof Element)) return;
  if (target.closest("a[href]")) e.preventDefault();
  if (!target.closest("[data-hero-live]")) e.stopPropagation();
}

const prevent = (e: SyntheticEvent) => e.preventDefault();

export function HeroSandbox({ children, fallback = null, className }: { children: ReactNode; fallback?: ReactNode; className?: string }) {
  return (
    <ErrorBoundary name="HeroFlythrough" fallback={fallback} silent>
      <ConvexProvider client={heroConvexStub}>
        <ThemeContext.Provider value={HERO_THEME}>
          <PersonifyOverride.Provider value={false}>
            <EntityFixtureContext.Provider value={HERO_ENTITIES}>
              <RevealInBandCtx.Provider value={true}>
                <div
                  className={`hero-sandbox${className ? ` ${className}` : ""}`}
                  data-hero-sandbox=""
                  onClickCapture={cancelNav}
                  onAuxClickCapture={cancelNav}
                  onDoubleClickCapture={cancelNav}
                  onPointerDownCapture={cancelNav}
                  onMouseDownCapture={cancelNav}
                  onKeyDownCapture={cancelNav}
                  onSubmitCapture={prevent}
                  onDragStartCapture={prevent}
                  onDropCapture={prevent}
                  onContextMenuCapture={prevent}
                >
                  {children}
                </div>
              </RevealInBandCtx.Provider>
            </EntityFixtureContext.Provider>
          </PersonifyOverride.Provider>
        </ThemeContext.Provider>
      </ConvexProvider>
    </ErrorBoundary>
  );
}

/** Around each part: a broken or still-loading part leaves its region empty instead of taking the film down. */
export function HeroPartBoundary({ name, children }: { name: string; children: ReactNode }) {
  return (
    <ErrorBoundary name={`HeroFlythrough:${name}`} fallback={null} silent>
      {children}
    </ErrorBoundary>
  );
}
