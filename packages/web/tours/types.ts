// Tours: a short guided walk through one feature, anchored to the real UI.
//
// A tour is a list of steps. Each step points at one control (a CSS selector)
// and says one or two plain sentences about it; a step may open the panel it
// points at first, and may carry a "do it now" button. The engine
// (TourLayer) draws a spotlight over the control and the card beside it, and
// moves the page to the tour's route when it starts somewhere else.
//
// Every tour is registered once in tours/registry.ts and listed in the Tours
// panel, so anyone can replay any tour. Whether a person has seen a tour is
// one record on the store, synced across devices (tours/seen.ts): a tour that
// starts itself the first time someone meets a feature never starts twice.

export type TourArea = "org" | "inbox" | "session" | "work" | "triggers";

export type TourStep = {
  id: string;
  /** The control the step spotlights, as a CSS selector; null = no highlight,
   *  the card sits in the middle. The first match wins. */
  target: string | null;
  /** Two or three short words over the body. */
  title: string;
  /** One or two plain sentences. */
  body: string;
  /** Before the step shows: when nothing matches `until`, click `click` (a
   *  button that opens the panel the step points at) and wait for it. */
  prepare?: { click: string; until: string };
  /** The step's own "do it now" button: clicks a control and moves on.
   *  Shown only while `when` matches (default: always). */
  action?: { label: string; click: string; when?: string };
  /** The step is skipped when its target is not on the page (a role card in
   *  a workspace with no roles). */
  optional?: boolean;
  /** The target lives inside a dialog (aria-modal); the layer may draw over
   *  one open modal instead of waiting for it to close. */
  insideModal?: boolean;
};

export type TourRoute = {
  /** Where to go when the tour starts somewhere else. */
  href: string;
  /** Whether a pathname is already on the tour's page. */
  match: (pathname: string) => boolean;
};

export type TourDef = {
  id: string;
  title: string;
  /** One line: what a person knows after it. Shown in the Tours panel. */
  teaches: string;
  area: TourArea;
  /** Null: the tour runs wherever it is started. */
  route: TourRoute | null;
  /** A spotlight tour runs through TourLayer; a modal tour has its own
   *  screens (the inbox tour) and only shares the record and the panel. */
  kind?: "spotlight" | "modal";
  steps: TourStep[];
  /** Records written before the tours existed that count as having seen it. */
  legacy?: { tips?: string[]; ui?: string[] };
};

/** The tour running right now (store.tour). `replay`: a person started it
 *  from the panel or a link, so it may run even when already seen. */
export type TourRun = { id: string; step: number; replay: boolean };

export const TOUR_AREAS: { area: TourArea; label: string; accent: string }[] = [
  { area: "org", label: "Organization", accent: "var(--sol-violet)" },
  { area: "inbox", label: "Inbox", accent: "var(--sol-cyan)" },
  { area: "session", label: "Sessions", accent: "var(--sol-blue)" },
  { area: "work", label: "Tasks and plans", accent: "var(--sol-orange)" },
  { area: "triggers", label: "Triggers", accent: "var(--sol-yellow)" },
];

export function tourAccent(area: TourArea): string {
  return TOUR_AREAS.find((a) => a.area === area)?.accent ?? "var(--sol-violet)";
}
