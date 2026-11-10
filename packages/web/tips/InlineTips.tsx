import { X } from 'lucide-react';
import { useTrackedStore } from '../store/inboxStore';
import { getInlineTips } from './registry';
import { formatShortcutParts, getShortcutsForAction } from '../shortcuts/registry';
import { KeyCap } from '../components/KeyboardShortcutsHelp';
import { track } from '../lib/analytics';

export function InlineTips() {
  const s = useTrackedStore([
    s => s.clientState.tips,
    s => s.clientStateInitialized,
  ]);
  const tips = s.clientState.tips;
  const initialized = s.clientStateInitialized;

  if (!initialized || tips?.level === 'none') return null;
  if (tips?._inlineSuppressed) return null;

  const seen = tips?.seen ?? [];
  const dismissed = tips?.dismissed ?? [];
  const allDismissed = new Set([...seen, ...dismissed]);

  const total = seen.length + (tips?.completed?.length ?? 0);
  const phase = total >= 15 ? 4 : total >= 8 ? 3 : total >= 3 ? 2 : 1;
  const visible = getInlineTips()
    .filter(t => t.phase <= phase && !allDismissed.has(t.id))
    .slice(0, 1);

  if (visible.length === 0) return null;

  const dismiss = (tipId: string) => {
    s.updateClientTips({
      seen: [...seen, tipId],
      dismissed: [...dismissed, tipId],
      _inlineSuppressed: true,
    });
    track('inline_tip_dismissed', { tip_id: tipId });
  };

  const tip = visible[0];
  const parts = tip.shortcutAction
    ? formatShortcutParts(getShortcutsForAction(tip.shortcutAction)[0])
    : undefined;

  return (
    <div className="border-b border-sol-border/30">
      <div className="group/tip flex items-center gap-2 px-3 py-1.5 bg-sol-cyan/[0.04] border-b border-sol-cyan/10 last:border-b-0 hover:bg-sol-cyan/[0.08] transition-colors">
        <span className="text-[11px] text-sol-text-muted flex-1 min-w-0">{tip.content}</span>
        {parts && (
          <span className="flex items-center gap-0.5 flex-shrink-0">
            {parts.map((p, i) => <KeyCap key={i} size="xs">{p}</KeyCap>)}
          </span>
        )}
        <button
          onClick={() => dismiss(tip.id)}
          className="p-0.5 text-sol-text-dim/0 group-hover/tip:text-sol-text-dim hover:!text-sol-text transition-colors flex-shrink-0"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
