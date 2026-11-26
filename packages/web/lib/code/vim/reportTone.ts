import type { VimDirectiveStatus } from "./types";

/** Each vimrc directive status's ink: its text, dot and filter chip. */
export const STATUS_TONE: Record<VimDirectiveStatus, { text: string; dot: string; chip: string }> = {
  applied: { text: "text-sol-green", dot: "bg-sol-green", chip: "border-sol-green/60 bg-sol-green/10 text-sol-green" },
  translated: { text: "text-sol-cyan", dot: "bg-sol-cyan", chip: "border-sol-cyan/60 bg-sol-cyan/10 text-sol-cyan" },
  skipped: { text: "text-sol-yellow", dot: "bg-sol-yellow", chip: "border-sol-yellow/60 bg-sol-yellow/10 text-sol-yellow" },
};
