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
 *   focus         nothing in the hero is in the page's tab order (the film is
 *                 aria-hidden and mostly off-camera); a pointer may still focus
 *                 a live text field, and focus anywhere else (a pressed button
 *                 or link, live or not) is let go at once
 *   errors        caught here, reported without a toast
 *
 * The theme lock here covers tokens only: `.hero-sandbox` re-declares the
 * light tokens, but globals.css also styles descendants of `.dark` and
 * `.minimal-style` directly (fonts, section headers, diff lines). Those stay
 * off because the boot script in index.html adds neither class on the
 * homepage and MarketingLayout's useThemeLock("light") holds it light.
 *
 * The mount policy in ARCHITECTURE.md lists the containers that must never
 * render in here; sandbox.guard.test.tsx proves the isolation.
 */

import { useRef, type FocusEvent, type ReactNode, type SyntheticEvent } from "react";
import { ConvexProvider } from "convex/react";
import { MemoryRouter, UNSAFE_LocationContext } from "react-router";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ThemeContext } from "@/components/ThemeProvider";
import { PersonifyOverride } from "@/hooks/usePersonifyAll";
import { EntityFixtureContext } from "@/lib/entityDisplay";
import { HoverCardsOff } from "@/lib/hoverCardsOff";
import { RevealInBandCtx } from "@/lib/revealHost";
import { TeamFeatureOverride } from "@/lib/teamFeatures";
import { TaskActiveSessionsOverride } from "@/components/tasks/taskActiveSession";
import { useWatchEffect } from "@/hooks/useWatchEffect";
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
const linkOf = (target: EventTarget | null) => (target instanceof Element ? target.closest("a[href]") : null);

function cancelNav(e: SyntheticEvent) {
  const target = e.target;
  if (!(target instanceof Element)) return;
  const link = linkOf(target);
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

/** Everything a Tab key could land on. */
const FOCUSABLE = "a[href],button,input,textarea,select,iframe,summary,[tabindex],[contenteditable=''],[contenteditable=true]";

/** Out of the tab order: the element and every focusable under it. */
function untab(root: Element) {
  const all = root.matches(FOCUSABLE) ? [root, ...root.querySelectorAll(FOCUSABLE)] : root.querySelectorAll(FOCUSABLE);
  for (const el of all) if (el.getAttribute("tabindex") !== "-1") el.setAttribute("tabindex", "-1");
}

/** What keeps focus inside a live element: somewhere to type. */
const TEXT_FIELD = "textarea,[contenteditable=''],[contenteditable=true],input:not([type=button],[type=submit],[type=reset],[type=checkbox],[type=radio],[type=range],[type=color],[type=file],[type=image])";

/**
 * Focus is let go at once unless it lands in a live text field: a pressed
 * button or link still gets its click, but the page's focus never stays on an
 * invisible control inside the aria-hidden film, where Space and Enter would
 * go to it instead of scrolling the page.
 */
function releaseFocus(e: FocusEvent) {
  const target = e.target;
  if (target instanceof HTMLElement && !(target.closest("[data-hero-live]") && target.matches(TEXT_FIELD))) target.blur();
}

const NO_FEATURES = {};
/** No fixture task is being worked live: the visitor's own store never lights one up. */
const NO_ACTIVE_SESSIONS = {};
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
  const rootRef = useRef<HTMLDivElement>(null);
  // Views mount and re-render as the film moves, so every element that arrives (or gets a tabindex back) leaves the tab order as it does.
  useWatchEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    untab(root);
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "attributes") {
          if (r.target instanceof Element) untab(r.target);
        } else for (const n of r.addedNodes) if (n instanceof Element) untab(n);
      }
    });
    mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["tabindex", "href"] });
    // Under React's own handlers, a native one: a link React no longer owns, or one rendered by code outside React, still never navigates.
    const keepLinks = (e: Event) => {
      if (linkOf(e.target)) e.preventDefault();
    };
    root.addEventListener("click", keepLinks, true);
    root.addEventListener("auxclick", keepLinks, true);
    return () => {
      mo.disconnect();
      root.removeEventListener("click", keepLinks, true);
      root.removeEventListener("auxclick", keepLinks, true);
    };
  }, []);
  return (
    <ErrorBoundary name="HeroFlythrough" fallback={fallback} silent>
      <ConvexProvider client={heroConvexStub}>
        <ThemeContext.Provider value={HERO_THEME}>
          <PersonifyOverride.Provider value={false}>
          <TeamFeatureOverride.Provider value={NO_FEATURES}>
            <EntityFixtureContext.Provider value={HERO_ENTITIES}>
              <RevealInBandCtx.Provider value={true}>
              <HoverCardsOff.Provider value={true}>
              <TaskActiveSessionsOverride.Provider value={NO_ACTIVE_SESSIONS}>
                <HeroRouter>
                  <div
                    ref={rootRef}
                    className={`hero-sandbox${className ? ` ${className}` : ""}`}
                    data-hero-sandbox=""
                    onFocusCapture={releaseFocus}
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
              </TaskActiveSessionsOverride.Provider>
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
