import { useCallback } from 'react';
import { useInboxStore, type ClientTips } from '../store/inboxStore';
import { getTip, getWhisperForAction, type TipDef } from './registry';
import { getShortcutsForAction, formatShortcutParts, type ShortcutAction } from '../shortcuts/registry';
import { track } from '../lib/analytics';
import { showMilestoneTip } from './TipMilestone';
const NUDGE_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_NUDGES_PER_SESSION = 3;
const GRACE_PERIOD_MS = 2 * 60 * 1000;

let sessionNudgeCount = 0;
let lastNudgeTs = 0;
let appStartTs = Date.now();

export interface WhisperState {
  tip: TipDef;
  shortcutLabel: string[];
  x: number;
  y: number;
  visible: boolean;
}

export interface NudgeState {
  tip: TipDef;
  shortcutLabel?: string[];
  anchorId?: string;
}

function getTipsState() {
  return useInboxStore.getState().clientState.tips;
}

export function useTips() {
  const updateTips = useInboxStore(s => s.updateClientTips);

  const isSeen = useCallback((tipId: string) => {
    return getTipsState()?.seen?.includes(tipId) ?? false;
  }, []);

  const isDismissed = useCallback((tipId: string) => {
    return getTipsState()?.dismissed?.includes(tipId) ?? false;
  }, []);

  const isCompleted = useCallback((tipId: string) => {
    return getTipsState()?.completed?.includes(tipId) ?? false;
  }, []);

  const isDisabled = useCallback(() => {
    return getTipsState()?.level === 'none';
  }, []);

  const currentPhase = useCallback((): number => {
    const tips = getTipsState();
    const completed = tips?.completed?.length ?? 0;
    const seen = tips?.seen?.length ?? 0;
    const total = completed + seen;
    if (total >= 15) return 4;
    if (total >= 8) return 3;
    if (total >= 3) return 2;
    return 1;
  }, []);

  const canShow = useCallback((tip: TipDef): boolean => {
    if (!useInboxStore.getState().clientStateInitialized) return false;
    const tips = getTipsState();
    if (tips?.level === 'none') return false;
    if (isSeen(tip.id) || isDismissed(tip.id)) return false;
    if (tip.phase > currentPhase()) return false;
    if (Date.now() - appStartTs < GRACE_PERIOD_MS && tip.type !== 'milestone') return false;
    return true;
  }, [isSeen, isDismissed, currentPhase]);

  const canShowNudge = useCallback((): boolean => {
    if (sessionNudgeCount >= MAX_NUDGES_PER_SESSION) return false;
    if (Date.now() - lastNudgeTs < NUDGE_COOLDOWN_MS) return false;
    return true;
  }, []);

  const markSeen = useCallback((tipId: string) => {
    const prev = getTipsState()?.seen ?? [];
    if (prev.includes(tipId)) return;
    updateTips({ seen: [...prev, tipId] });
    track('tip_seen', { tip_id: tipId, type: getTip(tipId)?.type });
  }, [updateTips]);

  const markDismissed = useCallback((tipId: string) => {
    const prev = getTipsState()?.dismissed ?? [];
    if (prev.includes(tipId)) return;
    updateTips({ dismissed: [...prev, tipId] });
    track('tip_dismissed', { tip_id: tipId, type: getTip(tipId)?.type });
  }, [updateTips]);

  const markCompleted = useCallback((tipId: string) => {
    const prev = getTipsState()?.completed ?? [];
    if (prev.includes(tipId)) return;
    updateTips({ completed: [...prev, tipId] });
    track('tip_completed', { tip_id: tipId, type: getTip(tipId)?.type });
  }, [updateTips]);

  const setLevel = useCallback((level: ClientTips['level']) => {
    updateTips({ level });
    track('tips_level_changed', { level });
  }, [updateTips]);

  return {
    currentPhase, canShow, canShowNudge,
    isSeen, isDismissed, isCompleted, isDisabled,
    markSeen, markDismissed, markCompleted, setLevel,
  };
}

export function getWhisperData(
  action: ShortcutAction,
  event: MouseEvent | React.MouseEvent,
): { tip: TipDef; shortcutLabel: string[]; x: number; y: number } | null {
  const tip = getWhisperForAction(action);
  if (!tip) return null;
  const defs = getShortcutsForAction(action);
  if (defs.length === 0) return null;
  const shortcutLabel = formatShortcutParts(defs[0]);
  const rect = (event.target as HTMLElement)?.getBoundingClientRect?.();
  const x = rect ? rect.left + rect.width / 2 : event.clientX;
  const y = rect ? rect.top : event.clientY;
  return { tip, shortcutLabel, x, y };
}

export function recordNudgeShown() {
  sessionNudgeCount++;
  lastNudgeTs = Date.now();
}

export function resetGracePeriod() {
  appStartTs = Date.now();
}

export function checkMilestone(tipId: string) {
  const state = useInboxStore.getState();
  const tips = state.clientState.tips;
  if (tips?.level === 'none') return;
  if (tips?.seen?.includes(tipId)) return;
  if (!state.clientStateInitialized) return;
  const tip = getTip(tipId);
  if (!tip) return;
  const seen = [...(tips?.seen ?? []), tipId];
  state.updateClientTips({ seen });
  showMilestoneTip(tip);
  track('tip_seen', { tip_id: tipId, type: 'milestone' });
}

const _firedShortcuts = new Set<string>();

export function onShortcutUsed(action: ShortcutAction) {
  if (_firedShortcuts.has(action)) return;
  _firedShortcuts.add(action);
  if (_firedShortcuts.size === 1) {
    checkMilestone('m-first-shortcut');
  }
}
