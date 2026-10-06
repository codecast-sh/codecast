// The handful of glyphs the chrome needs, drawn in ink at 2.5px like everything else.
const base = { fill: "none", stroke: "currentColor", strokeWidth: 2.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const CloseIcon = () => (
  <svg viewBox="0 0 24 24" {...base}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
export const LinkIcon = () => (
  <svg viewBox="0 0 24 24" {...base}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>
);
export const TimelineIcon = () => (
  <svg viewBox="0 0 24 24" {...base}><path d="M2 12h20" /><circle cx="6" cy="12" r="2.5" fill="var(--paper)" /><circle cx="13" cy="12" r="2.5" fill="var(--paper)" /><circle cx="19" cy="12" r="3" fill="var(--mint)" /></svg>
);
export const ArrowUpIcon = () => (
  <svg viewBox="0 0 24 24" {...base} strokeWidth={3}><path d="M12 19V5M5 12l7-7 7 7" /></svg>
);
export const ArrowRightIcon = () => (
  <svg viewBox="0 0 24 24" {...base}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
export const PickIcon = () => (
  <svg viewBox="0 0 24 24" {...base}>
    <rect x="3" y="3" width="13" height="13" rx="3" strokeDasharray="3 3" />
    <path d="M12 12l8 3-3.2 1.6L15 20z" fill="currentColor" />
  </svg>
);
export const SpeechGlyph = () => (
  <svg viewBox="0 0 20 18" width="18" height="16" aria-hidden>
    <path d="M3 1h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8l-5 4v-4H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z" fill="currentColor" />
    <path d="M5 7h10" stroke="var(--ink)" strokeWidth="2.5" strokeLinecap="round" />
  </svg>
);
export const DiceIcon = () => (
  <svg viewBox="0 0 24 24" {...base}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="4" fill="var(--paper)" transform="rotate(-10 12 12)" />
    <circle cx="8.5" cy="8.5" r="1.4" fill="currentColor" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /><circle cx="15.5" cy="15.5" r="1.4" fill="currentColor" />
  </svg>
);
export const CheckIcon = () => (
  <svg viewBox="0 0 24 24" {...base} strokeWidth={3}><path d="M5 12.5l4.5 4.5L19 7" /></svg>
);
