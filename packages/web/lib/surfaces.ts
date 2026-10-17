// The live readers of hosted mode's surface registry (lib/surfaceRules.ts):
// hooks for components, a getState reader for palette rows and shortcut
// handlers, and <Surface> for a mount that is simply on or off.
import { Fragment, createElement, useMemo, type ReactNode } from "react";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { makeCollectionSig } from "../store/wakeSig";
import { isHostedUi, simpleModeAllowed } from "../components/simple/lanePaths";
import type { LaneHint } from "../components/simple/laneBoot";
import { hasNoMachine, type DefaultAgentState } from "./defaultAgent";
import { assistantScopeOnly, inAssistantScope } from "./assistantScope";
import { HOSTED_ACTION_WORDS as HOSTED_ACTION_WORDS_OF, MODE_WORDS, actionSurface as actionSurfaceOf, shownFor, staffGateOpen, surfaceMode, type DevSurface, type ModeWords, type SurfaceMode } from "./surfaceRules";

export { DEV_SURFACES, DEVELOPER_MODE, HOSTED_ACTION_WORDS, MODE_WORDS, actionSurface, helpContextSurface, hiddenPageRedirect, modePageLabel, pageSurface, type DevSurface, type ModeWords, type SurfaceMode } from "./surfaceRules";

/** The slice of store state the registry reads. */
export type SurfaceState = Pick<DefaultAgentState, "clientState" | "machineRoster" | "machineRosterLive">;

/** True in hosted mode. Until the client state says (a cold load before
 *  hydration, a brand-new signup with no cache), the device's last known mode
 *  (laneBoot.ts readLaneHint) decides, so developer chrome never flashes for
 *  a hosted person. */
export function isHostedMode(s: Pick<SurfaceState, "clientState"> & { laneHint?: LaneHint | null; currentUser?: { staff?: boolean } | null }): boolean {
  if (!simpleModeAllowed(s.currentUser)) return false;
  const ui = s.clientState.ui;
  return ui?.lane !== undefined ? isHostedUi(ui) : s.laneHint === "simple";
}

/** Whether `name` shows for this viewer. */
export function surfaceShown(s: SurfaceState & { laneHint?: LaneHint | null; currentUser?: { staff?: boolean } | null }, name: DevSurface): boolean {
  return staffGateOpen(isStaffViewer(s), name) && shownFor(isHostedMode(s), hasNoMachine(s), name);
}

function isStaffViewer(s: { currentUser?: { staff?: boolean } | null }): boolean {
  return s.currentUser?.staff === true;
}

/** Live: whether `name` shows. */
export function useSurface(name: DevSurface): boolean {
  return useInboxStore((s) => surfaceShown(s, name));
}

/** Live: whether the viewer is in hosted mode. */
export function useHostedMode(): boolean {
  return useInboxStore(isHostedMode);
}

/** Live: whether hosted mode's doors are open to the viewer (lanePaths
 *  simpleModeAllowed). */
export function useSimpleModeAllowed(): boolean {
  return useInboxStore((s) => simpleModeAllowed(s.currentUser));
}

/** Outside React: whether hosted mode's doors are open to the viewer now. */
export function simpleModeAllowedNow(): boolean {
  return simpleModeAllowed(useInboxStore.getState().currentUser);
}

/** Live: hosted mode's Assistant/Everything scope (lib/assistantScope):
 *  whether lists show only the assistant's work, whether there is a scope to
 *  switch at all (hosted mode), and the switch. */
export function useAssistantScope(): { only: boolean; hosted: boolean; setEverything: (everything: boolean) => void } {
  const only = useInboxStore((s) => assistantScopeOnly(s.clientState.ui));
  const hosted = useHostedMode();
  return { only, hosted, setEverything: setAssistantScopeEverything };
}

/** Live: the ids of the assistant's conversations, for lists whose rows
 *  name a conversation (an approval, a queue item). Re-renders only when the
 *  set changes, never on a heartbeat. */
export function useAssistantConversationIds(): ReadonlySet<string> {
  const s = useTrackedStore([(st) => assistantIdsSig(st.sessions)]);
  const sig = assistantIdsSig(s.sessions);
  return useMemo(() => {
    const ids = new Set<string>();
    for (const id in s.sessions) if (inAssistantScope(s.sessions[id]?.agent_type)) ids.add(id);
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
}
// Memoized by the collection and per row: the selector runs on every store
// write, and a walk of every session there costs each write the whole cache.
const assistantIdsSig = makeCollectionSig<{ agent_type?: string }>((row) => (inAssistantScope(row?.agent_type) ? "1" : ""));

function setAssistantScopeEverything(everything: boolean): void {
  useInboxStore.getState().updateClientUI({ hosted_inbox_everything: everything });
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
  const staff = useInboxStore(isStaffViewer);
  return useMemo(() => surfaceMode(hosted, noMachine, staff), [hosted, noMachine, staff]);
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
