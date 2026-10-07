// The chrome's glyphs: 16px strokes at 1.7, round caps, in currentColor
// (DESIGN 4.3). Size them with CSS; dense rows set 13px and a 2px stroke.
import type { ReactNode } from "react";

const Icon = ({ children, stroke = 1.7 }: { children: ReactNode; stroke?: number }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

export const CloseIcon = () => <Icon><path d="M4 4l8 8M12 4l-8 8" /></Icon>;
export const LinkIcon = () => (
  <Icon><path d="M7 9a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.7.7M9 7a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.7-.7" /></Icon>
);
/** A scrubber: versions as ticks on a rail, the live one a filled dot. */
export const TimelineIcon = () => (
  <Icon><path d="M1.5 8h9M2.5 4.5v7M6.5 4.5v7" /><circle cx="12.5" cy="8" r="2.2" fill="currentColor" /></Icon>
);
export const ArrowUpIcon = () => <Icon stroke={2.1}><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" /></Icon>;
export const ArrowRightIcon = () => <Icon><path d="M3 8h10M9 4l4 4-4 4" /></Icon>;
export const PickIcon = () => (
  <Icon>
    <path d="M2.5 6V3.5a1 1 0 0 1 1-1H6M10 2.5h2.5a1 1 0 0 1 1 1V6M2.5 10v2.5a1 1 0 0 0 1 1H6" />
    <path d="M8.5 8.5l5 1.8-2.2.9-.9 2.2z" />
  </Icon>
);
export const ChatIcon = () => (
  <Icon><path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" /></Icon>
);
export const DiceIcon = () => (
  <Icon>
    <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
    <circle cx="5.7" cy="5.7" r=".6" fill="currentColor" /><circle cx="8" cy="8" r=".6" fill="currentColor" /><circle cx="10.3" cy="10.3" r=".6" fill="currentColor" />
  </Icon>
);
export const ChevronDownIcon = () => <Icon><path d="M4.5 6.5L8 10l3.5-3.5" /></Icon>;
export const CheckIcon = () => <Icon><path d="M3.5 8.5l3 3 6-7" /></Icon>;
export const RestoreIcon = () => <Icon><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9L2.5 5.7" /><path d="M2.5 2.5v3.2h3.2" /></Icon>;
export const ForkIcon = () => (
  <Icon>
    <circle cx="4.5" cy="3.5" r="1.5" /><circle cx="11.5" cy="3.5" r="1.5" /><circle cx="8" cy="12.5" r="1.5" />
    <path d="M4.5 5v1.5a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2V5M8 8.5V11" />
  </Icon>
);
export const ClockIcon = () => <Icon><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></Icon>;
