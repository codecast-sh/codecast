// The phone's text size step, provided once at the root (TextSizeProvider in
// hooks/useTextSize.ts) and read by every Themed Text and TextInput, so no Text
// holds a store subscription of its own. Outside the provider it is Small,
// the size each style was written at.
import { createContext } from 'react';
import type { TextSize } from './textSize';

export const TextSizeContext = createContext<TextSize>('small');
