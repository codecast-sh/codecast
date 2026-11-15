import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  AGENT_MODEL_CONFIG,
  cloudAgentProviderForLaunch,
  modelAgentKey,
} from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";
import { withoutUndo } from "../store/undoStack";
import { liveSessionMetaOf } from "../hooks/useLiveSessionMeta";
import { canControlModel, modelOptionKey } from "./modelSwitch";
import { commitModelChange } from "./modelSwitchWeb";

// Raising and lowering a session's effort one level at a time, from the keys
// (Alt+. / Alt+, as in Codex) and from ←/→ inside an open effort menu (as in
// Claude Code's picker). Both rails share this: a blank session relaunches
// with the new flag, a live one gets one `/effort` message.

/** The levels a session can step through, lowest first; empty where codecast
 *  sets no effort (a client without levels, a cloud agent). */
export function effortLevelsFor(agentType: string | undefined, model: string | null | undefined, sessionId?: string | null, blank = true): readonly string[] {
  const cfg = AGENT_MODEL_CONFIG[modelAgentKey(agentType)];
  if (!cfg || cfg.efforts.length === 0) return [];
  if (blank ? cloudAgentProviderForLaunch(agentType, modelOptionKey(model ?? undefined, agentType)) : !canControlModel(agentType, sessionId, model)) return [];
  return cfg.efforts;
}

/** Where an unpinned session sits on the scale: the agent's own default is
 *  not known here, so it reads as "high" where that exists, else the middle. */
export function effortPosition(levels: readonly string[], effort: string | null | undefined): number {
  const at = effort ? levels.indexOf(effort) : -1;
  if (at >= 0) return at;
  const high = levels.indexOf("high");
  return high >= 0 ? high : Math.floor((levels.length - 1) / 2);
}

/** The next level up (dir 1) or down (-1), or null at the end of the scale.
 *  An unpinned session's first step lands on the level its position names. */
export function stepEffortLevel(levels: readonly string[], effort: string | null | undefined, dir: 1 | -1): string | null {
  if (levels.length === 0) return null;
  const pinned = !!effort && levels.includes(effort);
  if (!pinned) return levels[effortPosition(levels, effort)];
  const next = levels.indexOf(effort!) + dir;
  return next >= 0 && next < levels.length ? levels[next] : null;
}

// ── The pulse: what the effort controls show right after a key moved them ──

export type EffortPulse = { at: number; edge: boolean };
const pulses = new Map<string, EffortPulse>();
const listeners = new Set<() => void>();
function pulse(conversationId: string, edge: boolean) {
  pulses.set(conversationId, { at: Date.now(), edge });
  for (const fn of [...listeners]) fn();
}

/** The last key step on this conversation's effort, for a brief highlight
 *  (or a shake, `edge`, when the scale had no further level). */
export function useEffortPulse(conversationId: string | undefined): EffortPulse | undefined {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => (conversationId ? pulses.get(useInboxStore.getState().resolveLiveSessionId(conversationId)) : undefined),
    () => undefined,
  );
}

// ── Stepping ──

const SETTLE_MS = 650;
const bursts = new Map<string, { before: { model?: string | null; effort?: string | null }; timer: ReturnType<typeof setTimeout> }>();

/**
 * Moves a session's effort one level. The control repaints on the press; the
 * switch itself (a relaunch flag, or a `/effort` message to a live agent) goes
 * once the keys settle, so a run of presses sends one change, from where the
 * run started to where it ended. Always takes the press (a session with no
 * effort levels says so), so the key never types its character into the box.
 */
export function stepEffort(viewId: string, dir: 1 | -1, blank: boolean): boolean {
  const store = useInboxStore.getState();
  // The row the session lives on now (a blank session's stub rekeys on create).
  const conversationId = store.resolveLiveSessionId(viewId);
  const live = liveSessionMetaOf(store, conversationId);
  const agentType = live?.agentType ?? "claude_code";
  const levels = effortLevelsFor(agentType, live?.model, live?.sessionId, blank);
  if (levels.length === 0) {
    toast("This agent takes no effort level from codecast");
    return true;
  }
  const next = stepEffortLevel(levels, live?.effort, dir);
  if (next === null) { pulse(conversationId, true); return true; }

  const burst = bursts.get(conversationId);
  const before = burst?.before ?? { model: live?.model ?? null, effort: live?.effort ?? null };
  if (burst) clearTimeout(burst.timer);
  withoutUndo(() => store.setConversationModel(conversationId, { effort: next }));
  pulse(conversationId, false);

  const timer = setTimeout(() => {
    bursts.delete(conversationId);
    const s = useInboxStore.getState();
    // A pick from the menu while the keys settled already committed its own
    // level: that one stands.
    if ((liveSessionMetaOf(s, conversationId)?.effort ?? null) !== next) return;
    // Put the start of the run back, unrecorded, so the one commit below is
    // a single undoable change from there to here.
    withoutUndo(() => s.setConversationModel(conversationId, { effort: before.effort ?? null }));
    if ((before.effort ?? null) === next) return;
    void commitModelChange({ conversationId, agentType, current: before, sel: { effort: next }, blank });
  }, SETTLE_MS);
  bursts.set(conversationId, { before, timer });
  return true;
}
