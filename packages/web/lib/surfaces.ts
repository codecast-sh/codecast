// The live readers of hosted mode's surface registry (lib/surfaceRules.ts):
// hooks for components, a getState reader for palette rows and shortcut
// handlers, and <Surface> for a mount that is simply on or off.
import { Fragment, createElement, useMemo, type ReactNode } from "react";
import { useInboxStore } from "../store/inboxStore";
import { isHostedUi } from "../components/simple/lanePaths";
import { hasNoMachine, type DefaultAgentState } from "./defaultAgent";
import { MODE_WORDS, shownFor, surfaceMode, type DevSurface, type ModeWords, type SurfaceMode } from "./surfaceRules";

export { DEV_SURFACES, DEVELOPER_MODE, MODE_WORDS, modePageLabel, pageSurface, type DevSurface, type ModeWords, type SurfaceMode } from "./surfaceRules";

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
