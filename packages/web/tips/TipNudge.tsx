import { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { NudgeState } from './useTips';
import { formatShortcutParts, getShortcutsForAction } from '../shortcuts/registry';

interface TipNudgeProps {
  nudge: NudgeState | null;
  onDismiss: (tipId: string) => void;
}

export function TipNudge({ nudge, onDismiss }: TipNudgeProps) {
  const [opacity, setOpacity] = useState(0);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!nudge) { setOpacity(0); return; }

    let anchor: HTMLElement | null = null;
    if (nudge.anchorId) {
      anchor = document.querySelector(`[data-tip-anchor="${nudge.anchorId}"]`);
    }

    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      setPos({ x: rect.right + 12, y: rect.top + rect.height / 2 });
    } else {
      setPos(null);
    }

    requestAnimationFrame(() => setOpacity(1));
  }, [nudge]);

  useEffect(() => {
    if (!nudge) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss(nudge.tip.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nudge, onDismiss]);

  if (!nudge) return null;

  const shortcutLabel = nudge.tip.shortcutAction
    ? formatShortcutParts(getShortcutsForAction(nudge.tip.shortcutAction)[0])
    : nudge.shortcutLabel;

  const style: React.CSSProperties = pos
    ? {
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        transform: `translateY(-50%) translateX(${opacity ? 0 : -8}px)`,
        opacity,
        transition: 'opacity 200ms ease, transform 200ms ease',
        zIndex: 500,
      }
    : {
        position: 'fixed',
        bottom: 80,
        right: 24,
        transform: `translateY(${opacity ? 0 : 8}px)`,
        opacity,
        transition: 'opacity 200ms ease, transform 200ms ease',
        zIndex: 500,
      };

  return createPortal(
    <div ref={ref} style={style}>
      <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-sol-bg-alt border border-sol-border/40 shadow-xl max-w-xs">
        <div className="flex-1 min-w-0">
          <p className="text-sm text-sol-text">{nudge.tip.content}</p>
          {shortcutLabel && (
            <div className="flex items-center gap-1 mt-1.5">
              {shortcutLabel.map((part, i) => (
                <span
                  key={i}
                  className="inline-block min-w-[1.25rem] px-1 py-0.5 text-[10px] font-mono text-center text-sol-cyan bg-sol-bg rounded border border-sol-border/60 leading-none"
                >
                  {part}
                </span>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={() => onDismiss(nudge.tip.id)}
          className="p-1 text-sol-text-dim hover:text-sol-text transition-colors flex-shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
