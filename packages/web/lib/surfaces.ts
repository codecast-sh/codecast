// The live readers of hosted mode's surface registry (lib/surfaceRules.ts):
// hooks for components, a getState reader for palette rows and shortcut
// handlers, and <Surface> for a mount that is simply on or off.
import { Fragment, createElement, useMemo, type ReactNode } from "react";
import { useInboxStore } from "../store/inboxStore";
import { isHostedUi } from "../components/simple/lanePaths";
import { hasNoMachine, type DefaultAgentState } from "./defaultAgent";
import { HOSTED_ACTION_WORDS as HOSTED_ACTION_WORDS_OF, MODE_WORDS, actionSurface as actionSurfaceOf, shownFor, surfaceMode, type DevSurface, type ModeWords, type SurfaceMode } from "./surfaceRules";

export { DEV_SURFACES, DEVELOPER_MODE, HOSTED_ACTION_WORDS, MODE_WORDS, actionSurface, helpContextSurface, modePageLabel, pageSurface, type DevSurface, type ModeWords, type SurfaceMode } from "./surfaceRules";

/** The slice of store state the registry reads. */
export type SurfaceState = Pick<DefaultAgentState, "clientState" | "machineRoster" | "machineRosterLive">;

/** True in hosted mode. */
export function isHostedMode(s: Pick<SurfaceState, "clientState">): boolean {
  return isHostedUi(s.clientState.ui);
}

/** Whether `name` shows for this viewer. */
export function surfaceShown(s: SurfaceState, name: DevSurface): boolean {
  return shownFor(isHostedMode(s), hasNoMachine(s), name);
}

/** Live: whether `name` shows. */
export function useSurface(name: DevSurface): boolean {
  return useInboxStore((s) => surfaceShown(s, name));
}

/** Live: whether the viewer is in hosted mode. */
export function useHostedMode(): boolean {
  return useInboxStore(isHostedMode);
}

/** Live: the words for the viewer's mode. */
export function useModeWords(): ModeWords {
  return MODE_WORDS[useHostedMode() ? "hosted" : "developer"];
}

/** Live: the whole mode, for a pure view that takes it as a prop. Stable
 *  while hosted mode and the machine roster's answer hold. */
export function useSurfaceMode(): SurfaceMode {
  const hosted = useHostedMode();
  const noMachine = useInboxStore(hasNoMachine);
  return useMemo(() => surfaceMode(hosted, noMachine), [hosted, noMachine]);
}

/** Outside React (palette rows, shortcut handlers): whether `name` shows now. */
export function surfaceShownNow(name: DevSurface): boolean {
  return surfaceShown(useInboxStore.getState(), name);
}

/** Outside React: the words for the viewer's mode now. */
export function modeWordsNow(): ModeWords {
  return MODE_WORDS[isHostedMode(useInboxStore.getState()) ? "hosted" : "developer"];
}

/** Renders its children only where `name` shows. */
export function Surface({ name, children }: { name: DevSurface; children: ReactNode }) {
  return useSurface(name) ? createElement(Fragment, null, children) : null;
}

/** Whether an action (a palette command, a shortcut) is offered in `mode`:
 *  its surface (lib/surfaceRules ACTION_SURFACES) shows, or it has none. */
export function actionShownIn(mode: SurfaceMode, action: string): boolean {
  const surface = actionSurfaceOf(action);
  return !surface || mode.shows(surface);
}

/** Outside React: whether an action is offered now. */
export function actionShownNow(action: string): boolean {
  const surface = actionSurfaceOf(action);
  return !surface || surfaceShownNow(surface);
}

/** An action's name in this mode: hosted mode's words where they differ. */
export function actionLabel(action: string, label: string, hosted: boolean): string {
  return (hosted && HOSTED_ACTION_WORDS_OF[action]) || label;
}
