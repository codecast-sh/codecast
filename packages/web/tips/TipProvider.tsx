import { createContext, useContext, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { type ShortcutAction } from '../shortcuts/registry';
import { getTip, getWhisperForAction } from './registry';
import { useTips, getWhisperData, recordNudgeShown, type WhisperState, type NudgeState } from './useTips';
import { TipWhisper } from './TipWhisper';
import { TipNudge } from './TipNudge';
import { showMilestoneTip } from './TipMilestone';

interface TipContextValue {
  whisper: (action: ShortcutAction, event: MouseEvent | React.MouseEvent) => void;
  milestone: (tipId: string) => void;
  nudge: (tipId: string, anchorId?: string) => void;
  dismiss: (tipId: string) => void;
}

const TipContext = createContext<TipContextValue>({
  whisper: () => {},
  milestone: () => {},
  nudge: () => {},
  dismiss: () => {},
});

export function useTipActions() {
  return useContext(TipContext);
}

export function TipProvider({ children }: { children: ReactNode }) {
  const { canShow, canShowNudge, markSeen, markDismissed, isDisabled } = useTips();
  const [whisperState, setWhisperState] = useState<WhisperState | null>(null);
  const [nudgeState, setNudgeState] = useState<NudgeState | null>(null);
  const whisperTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const whisper = useCallback((action: ShortcutAction, event: MouseEvent | React.MouseEvent) => {
    if (isDisabled()) return;
    const tip = getWhisperForAction(action);
    if (!tip || !canShow(tip)) return;
    const data = getWhisperData(action, event);
    if (!data) return;
    clearTimeout(whisperTimer.current);
    setWhisperState({ ...data, visible: true });
    markSeen(tip.id);
  }, [canShow, markSeen, isDisabled]);

  const milestone = useCallback((tipId: string) => {
    if (isDisabled()) return;
    const tip = getTip(tipId);
    if (!tip || !canShow(tip)) return;
    showMilestoneTip(tip);
    markSeen(tip.id);
  }, [canShow, markSeen, isDisabled]);

  const nudge = useCallback((tipId: string, anchorId?: string) => {
    if (isDisabled()) return;
    const tip = getTip(tipId);
    if (!tip || !canShow(tip) || !canShowNudge()) return;
    setNudgeState({ tip, anchorId });
    recordNudgeShown();
    markSeen(tip.id);
  }, [canShow, canShowNudge, markSeen, isDisabled]);

  const dismiss = useCallback((tipId: string) => {
    markDismissed(tipId);
    if (nudgeState?.tip.id === tipId) setNudgeState(null);
  }, [markDismissed, nudgeState]);

  const onWhisperDone = useCallback(() => {
    setWhisperState(null);
  }, []);

  const value = useMemo(() => ({ whisper, milestone, nudge, dismiss }), [whisper, milestone, nudge, dismiss]);

  return (
    <TipContext.Provider value={value}>
      {children}
      <TipWhisper whisper={whisperState} onDone={onWhisperDone} />
      <TipNudge nudge={nudgeState} onDismiss={dismiss} />
    </TipContext.Provider>
  );
}
