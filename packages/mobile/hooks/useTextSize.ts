import { useMemo } from 'react';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { resolveTextSize, sizedText, type TextSize } from '@/lib/textSize';

/** This phone's text size choice (Settings › Appearance › Text size). */
export function useTextSize(): TextSize {
  return useInboxStore((s) => resolveTextSize(s.clientState?.ui?.mobile_text_size));
}

/** A Small size raised to this phone's text size, as a stable style object. */
export function useSizedText(fontSize: number, lineHeight?: number): { fontSize: number; lineHeight?: number } {
  const size = useTextSize();
  return useMemo(() => sizedText(fontSize, lineHeight, size), [fontSize, lineHeight, size]);
}
