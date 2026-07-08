import { getLabelColor } from '@codecast/web/lib/labelColors';

// Web's label palette speaks Tailwind class names; RN needs hex. Reuse the
// canonical name→color assignment (semantic names + hash fallback) and map the
// dot token ("bg-red-500 …") through Tailwind's hex values so a label renders
// the same hue on phone and desktop.
const TW_HEX: Record<string, string> = {
  'red-500': '#ef4444',
  'blue-500': '#3b82f6',
  'cyan-500': '#06b6d4',
  'amber-500': '#f59e0b',
  'indigo-500': '#6366f1',
  'slate-500': '#64748b',
  'pink-500': '#ec4899',
  'orange-500': '#f97316',
  'yellow-500': '#eab308',
  'green-500': '#22c55e',
  'rose-500': '#f43f5e',
  'neutral-500': '#737373',
  'violet-500': '#8b5cf6',
  'emerald-500': '#10b981',
  'fuchsia-500': '#d946ef',
  'teal-500': '#14b8a6',
  'lime-600': '#65a30d',
  'sky-500': '#0ea5e9',
};

export function labelHexColor(name: string): string {
  const dot = getLabelColor(name).dot;
  const m = dot.match(/bg-([a-z]+-\d+)/);
  return (m && TW_HEX[m[1]]) || '#8b5cf6';
}
