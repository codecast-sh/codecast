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
 *   hover cards   tooltips, entity cards and fork previews never open: each
 *                 portals to the page's body, off the moving 3D plane
 *   location      a memory router of the hero's own at /inbox, so the views'
 *                 links and location reads never see or move the visitor's page
 *   team features all off, whatever the visitor's team turned on
 *   navigation    link clicks cancelled, their handlers never run; clicks,
 *                 presses and keys stop here unless the target sits inside a
 *                 `data-hero-live` element (and is not in a link),
 *                 and a message's own toolbar never acts even there (copy,
 *                 link, send to chat reach the clipboard, toasts and store)
 *   the page      nothing that happens in the hero reaches a document or
 *                 window listener (the page's navigation bar, outside-click
 *                 handlers), since every event stops at the sandbox
 *   drag, drop, context menus   cancelled before any view's handler
 *   errors        caught here, reported without a toast
 *
 * The mount policy in ARCHITECTURE.md lists the containers that must never
 * render in here; sandbox.guard.test.tsx proves the isolation.
 */

import type { ReactNode, SyntheticEvent } from "react";
import { ConvexProvider } from "convex/react";
import { MemoryRouter, UNSAFE_LocationContext } from "react-router";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ThemeContext } from "@/components/ThemeProvider";
import { PersonifyOverride } from "@/hooks/usePersonifyAll";
import { EntityFixtureContext } from "@/lib/entityDisplay";
import { HoverCardsOff } from "@/lib/hoverCardsOff";
import { RevealInBandCtx } from "@/lib/revealHost";
import { TeamFeatureOverride } from "@/lib/teamFeatures";
import { heroConvexStub } from "./convexStub";
import { HERO_ENTITIES } from "./fixtures";

const noop = () => {};
const HERO_THEME = { theme: "light" as const, toggleTheme: noop, visualStyle: "classic" as const, setVisualStyle: noop };

/** A message's corner toolbar: its actions write the clipboard, raise toasts and open the store's palette. */
const INERT = "[data-cc-assistant-message-toolbar],[data-cc-user-message-toolbar]";

/**
 * Links never navigate, and their own handlers never run, live or not: a
 * link's handler can act on the visitor's app (a sidebar row places a pane on
 * their stage, lib/stage). Anything else outside a `data-hero-live` element
 * never reaches the real handler under it.
 */
function cancelNav(e: SyntheticEvent) {
  const target = e.target;
  if (!(target instanceof Element)) return;
  const link = target.closest("a[href]");
  if (link) e.preventDefault();
  if (link || !target.closest("[data-hero-live]") || target.closest(INERT)) e.stopPropagation();
}

/** Whatever a live view did with the event, it goes no further than the hero. */
const contain = (e: SyntheticEvent) => e.stopPropagation();

/** Cancelled outright, before any view's handler: a context menu would open the app's own menu at document.body. */
const cancel = (e: SyntheticEvent) => {
  e.preventDefault();
  e.stopPropagation();
};

const prevent = (e: SyntheticEvent) => e.preventDefault();

const NO_FEATURES = {};
/** The toolbars never act, so they never show. */
const HERO_CSS = `.hero-sandbox ${INERT.split(",").join(",.hero-sandbox ")}{display:none!important}`;

/** The page's router is masked first, since a router refuses to mount inside another. */
function HeroRouter({ children }: { children: ReactNode }) {
  return (
    <UNSAFE_LocationContext.Provider value={null as never}>
      <MemoryRouter initialEntries={["/inbox"]}>{children}</MemoryRouter>
    </UNSAFE_LocationContext.Provider>
  );
}

export function HeroSandbox({ children, fallback = null, className }: { children: ReactNode; fallback?: ReactNode; className?: string }) {
  return (
    <ErrorBoundary name="HeroFlythrough" fallback={fallback} silent>
      <ConvexProvider client={heroConvexStub}>
        <ThemeContext.Provider value={HERO_THEME}>
          <PersonifyOverride.Provider value={false}>
          <TeamFeatureOverride.Provider value={NO_FEATURES}>
            <EntityFixtureContext.Provider value={HERO_ENTITIES}>
              <RevealInBandCtx.Provider value={true}>
              <HoverCardsOff.Provider value={true}>
                <HeroRouter>
                  <div
                    className={`hero-sandbox${className ? ` ${className}` : ""}`}
                    data-hero-sandbox=""
                    onClickCapture={cancelNav}
                    onAuxClickCapture={cancelNav}
                    onDoubleClickCapture={cancelNav}
                    onPointerDownCapture={cancelNav}
                    onMouseDownCapture={cancelNav}
                    onPointerUpCapture={cancelNav}
                    onMouseUpCapture={cancelNav}
                    onKeyDownCapture={cancelNav}
                    onKeyUpCapture={cancelNav}
                    onClick={contain}
                    onAuxClick={contain}
                    onDoubleClick={contain}
                    onPointerDown={contain}
                    onMouseDown={contain}
                    onPointerUp={contain}
                    onMouseUp={contain}
                    onKeyDown={contain}
                    onKeyUp={contain}
                    onSubmitCapture={prevent}
                    onDragStartCapture={prevent}
                    onDropCapture={prevent}
                    onContextMenuCapture={cancel}
                  >
                    <style>{HERO_CSS}</style>
                    {children}
                  </div>
                </HeroRouter>
              </HoverCardsOff.Provider>
              </RevealInBandCtx.Provider>
            </EntityFixtureContext.Provider>
          </TeamFeatureOverride.Provider>
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
