import { createElement, type ReactNode } from 'react';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { resolveTextSize, type TextSize } from '@/lib/textSize';
import { TextSizeContext } from '@/lib/textSizeContext';

/** This phone's text size choice (Settings › Appearance › Text size). */
export function useTextSize(): TextSize {
  return useInboxStore((s) => resolveTextSize(s.clientState?.ui?.mobile_text_size));
}

/** Hands the choice to every Themed Text and TextInput below it. */
export function TextSizeProvider({ children }: { children: ReactNode }) {
  return createElement(TextSizeContext.Provider, { value: useTextSize() }, children);
}
