import { useRef, useState, useMemo } from "react";

export function useSwipeToDismiss(onDismiss: () => void) {
  const [swipeY, setSwipeY] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const startY = useRef(0);

  const handlers = useMemo(() => ({
    onTouchStart: (e: React.TouchEvent) => {
      startY.current = e.touches[0].clientY;
      setSwiping(true);
      setSwipeY(0);
    },
    onTouchMove: (e: React.TouchEvent) => {
      if (!swiping) return;
      const dy = e.touches[0].clientY - startY.current;
      setSwipeY(Math.max(0, dy));
    },
    onTouchEnd: () => {
      if (swipeY > 120) {
        onDismiss();
      }
      setSwipeY(0);
      setSwiping(false);
    },
  }), [swiping, swipeY, onDismiss]);

  const style = useMemo(() => swipeY > 0 ? {
    transform: `translateY(${swipeY}px)`,
    transition: swiping ? 'none' : 'transform 0.2s ease-out',
  } : undefined, [swipeY, swiping]);

  const backdropOpacity = swipeY > 0 ? Math.max(0.2, 1 - swipeY / 300) : 1;

  return { handlers, style, backdropOpacity, swipeY };
}
