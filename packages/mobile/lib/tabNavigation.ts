// The one way to a tab.
//
// The tabs are one screen at the foot of the root stack, and every other
// screen (a conversation, a person, a call) is stacked over it. From over the
// tabs, expo-router 6 turns push, navigate and replace to a tab's address into
// a SECOND tabs screen on top, and leaves what was open mounted under it with
// every subscription live: leaving a conversation five times left five of them
// (store listeners 334 to 2,366, and the fifth open took twice as long as the
// first). From there the way to a tab is dismissTo, which pops back to the tabs
// that are already there, or puts them in the screen's place when none are
// beneath (a cold start from a link).
//
// From inside the tabs it is the other way round: dismissTo aims at the tab
// navigator, which does not know the action and does nothing, and navigate
// switches tabs in place.
//
// So which call is right depends on where the app is, and no call site should
// have to know. Every tab address reaches the router through goToTab
// (lib/tabNavigation.guard.test.ts holds that).

export const TABS_GROUP = '(tabs)';

/** What goToTab needs of expo-router's router (the hook's or the imported one). */
export type TabRouter = {
  navigate: (href: never) => void;
  dismissTo: (href: never) => void;
};

// Where the app is, as expo-router's useSegments reports it. The root layout
// writes it on every route change (noteRouteSegments), so code with no hook of
// its own (a tapped link, a notification) can ask.
let segments: readonly string[] = [];

export function noteRouteSegments(next: readonly string[]): void {
  segments = next;
}

/** A tab's address: the tabs group itself or anything under it. */
export function isTabAddress(href: string): boolean {
  return href === `/${TABS_GROUP}` || href.startsWith(`/${TABS_GROUP}/`) || href.startsWith(`/${TABS_GROUP}?`);
}

/**
 * Whether the tabs are the screen on top. Before the first route is known the
 * answer is yes: navigate from over the tabs costs a stacked screen, dismissTo
 * from inside them does nothing at all, and a tap that does nothing is worse.
 */
export function insideTabs(at: readonly string[] = segments): boolean {
  return at.length === 0 || at[0] === TABS_GROUP;
}

/** Go to a tab from wherever the app is, leaving nothing mounted behind. */
export function goToTab(router: TabRouter, href: string, at: readonly string[] = segments): void {
  if (insideTabs(at)) router.navigate(href as never);
  else router.dismissTo(href as never);
}
