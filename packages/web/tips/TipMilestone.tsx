import { toast } from 'sonner';
import type { TipDef } from './registry';

export function showMilestoneTip(tip: TipDef) {
  toast(tip.content, {
    duration: 4000,
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
