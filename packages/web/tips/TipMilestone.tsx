import { toast } from 'sonner';
import type { TipDef } from './registry';
import { MenuKeyCaps } from '../components/KeyboardShortcutsHelp';
import { useInboxStore } from '../store/inboxStore';
import { isHostedMode } from '../lib/surfaces';

// A tip that teaches a chord shows it as KeyCaps under the line, so no key
// name is ever written into the copy as plain text.
//
// Hosted mode's tips are hints, not celebrations: the toast's own calm look,
// no glow or badge, gone after a few seconds.
export function showMilestoneTip(tip: TipDef) {
  const keys = tip.shortcutAction ? { description: <MenuKeyCaps action={tip.shortcutAction} className="mt-1 flex items-center gap-[2px]" /> } : {};
  if (isHostedMode(useInboxStore.getState())) {
    toast(tip.content, { id: `tip-${tip.id}`, duration: 6000, ...keys });
    return;
  }
  toast(tip.content, {
    duration: 4000,
    ...keys,
    className: 'tip-milestone',
    style: {
      background: 'var(--sol-bg-alt)',
      border: '1px solid color-mix(in srgb, var(--sol-cyan) 30%, transparent)',
      color: 'var(--sol-text)',
      fontSize: '13px',
      boxShadow: '0 0 20px color-mix(in srgb, var(--sol-cyan) 10%, transparent)',
    },
    icon: <MilestoneIcon />,
  });
}

function MilestoneIcon() {
  return (
    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-sol-cyan/20 text-sol-cyan text-xs flex-shrink-0">
      *
    </span>
  );
}
