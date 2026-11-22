// Artifact color names ("yellow", a sheet's palette name) as the app theme's
// hex, the phone twin of web's boardColors.ts and sheet palette tokens.
import { mixHex, type Palette } from '@/constants/Theme';

export const BOARD_INK = '#22211d';
const PAPER = '#fffdf6';

const LIGHT_STICKY: Record<string, string> = {
  yellow: '#ffe68f', orange: '#ffd3a6', red: '#ffc4bd', pink: '#ffcbe5', violet: '#ddd0ff',
  blue: '#c9e0ff', cyan: '#bdeef0', green: '#c9efc1', gray: '#e4e4e1',
};

export function namedColor(name: unknown, t: Palette, fallback = 'gray'): string {
  const n = typeof name === 'string' ? name : fallback;
  switch (n) {
    case 'yellow': return t.yellow;
    case 'orange': return t.orange;
    case 'red': return t.red;
    case 'pink':
    case 'magenta': return t.magenta;
    case 'violet': return t.violet;
    case 'blue': return t.blue;
    case 'cyan': return t.cyan;
    case 'green': return t.green;
    case 'gray': return t.textDim;
    default: return n === fallback ? t.textDim : namedColor(fallback, t, 'gray');
  }
}

export function stickyPaper(name: unknown, t: Palette, dark: boolean): string {
  const n = typeof name === 'string' && name in LIGHT_STICKY ? name : 'yellow';
  return dark ? mixHex(namedColor(n, t), 36, PAPER) : LIGHT_STICKY[n];
}

export function tintOf(name: unknown, t: Palette, pct: number, fallback = 'blue'): string {
  return mixHex(namedColor(name, t, fallback), pct, t.bg);
}

/** Plain words from a board's light markdown (**bold**, *italic*, ~~strike~~, [label](url)). */
export function plainMarks(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2');
}

/** A new element key in the shared shape (`<prefix>_<8 chars>`), with no dependency on crypto. */
export function newKey(prefix: string): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${prefix}_${s}`;
}
