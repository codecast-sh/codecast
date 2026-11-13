import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WhisperState } from './useTips';

const FADE_IN_MS = 150;
const VISIBLE_MS = 3000;
const FADE_OUT_MS = 300;

interface TipWhisperProps {
  whisper: WhisperState | null;
  onDone: () => void;
}

export function TipWhisper({ whisper, onDone }: TipWhisperProps) {
  const [opacity, setOpacity] = useState(0);
  const [frozen, setFrozen] = useState<WhisperState | null>(null);

  useEffect(() => {
    if (!whisper?.visible) {
      setOpacity(0);
      const t = setTimeout(() => { setFrozen(null); onDone(); }, FADE_OUT_MS);
      return () => clearTimeout(t);
    }
    setFrozen(whisper);
    const fadeIn = requestAnimationFrame(() => setOpacity(1));
    const dismiss = setTimeout(() => setOpacity(0), FADE_IN_MS + VISIBLE_MS);
    const cleanup = setTimeout(() => { setFrozen(null); onDone(); }, FADE_IN_MS + VISIBLE_MS + FADE_OUT_MS);
    return () => {
      cancelAnimationFrame(fadeIn);
      clearTimeout(dismiss);
      clearTimeout(cleanup);
    };
  }, [whisper?.visible, whisper?.tip?.id]);

  const w = frozen ?? whisper;
  if (!w) return null;

  const style: React.CSSProperties = {
    position: 'fixed',
    left: w.x,
    top: w.y - 8,
    transform: `translate(-50%, -100%) translateY(${opacity ? 0 : 4}px)`,
    opacity,
    transition: `opacity ${opacity ? FADE_IN_MS : FADE_OUT_MS}ms ease, transform ${FADE_IN_MS}ms ease`,
    zIndex: 9999,
    pointerEvents: 'none',
  };

  return createPortal(
    <div style={style}>
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-sol-bg-alt border border-sol-border/40 shadow-lg backdrop-blur-sm">
        <span className="text-xs text-sol-text-muted whitespace-nowrap">{w.tip.content}</span>
        <kbd className="inline-flex items-center gap-0.5">
          {w.shortcutLabel.map((part, i) => (
            <span
              key={i}
              className="inline-block min-w-[1.25rem] px-1 py-0.5 text-[10px] font-mono text-center text-sol-cyan bg-sol-bg rounded border border-sol-border/60 leading-none"
            >
              {part}
            </span>
          ))}
        </kbd>
      </div>
    </div>,
    document.body,
  );
}
