// A key, drawn as a key cap: how every keyboard key in the app is shown
// (CLAUDE.md, UI conventions). Its own leaf, with no store and no app state,
// so a page that must carry nothing of the app (a guest's /meet page, the
// share pages; lib/__tests__/standaloneBootGraph.guard) can show one too.
// KeyboardShortcutsHelp re-exports it for its existing importers.
const KEYCAP_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

/** `onAccent` is a key on a filled accent button (white on red, say): the
 *  usual cap would read as a grey hole in it. `glass` and `onLight` are for
 *  surfaces that keep their own neutral look whatever the app theme (the
 *  agent dock floating over the desktop): a key on dark glass, and a key on a
 *  white button. */
const KEYCAP_TONES = {
  default: "text-sol-text-dim bg-sol-bg-alt border border-sol-border/50",
  onAccent: "text-white bg-white/15 border border-white/30",
  glass: "text-white/55 bg-white/[0.08] border border-white/15",
  onLight: "text-black/50 bg-black/[0.06] border border-black/15",
} as const;

export function KeyCap({ children, size = "sm", tone = "default" }: { children: React.ReactNode; size?: "sm" | "xs"; tone?: keyof typeof KEYCAP_TONES }) {
  const cls = size === "xs"
    ? "inline-flex items-center justify-center min-w-[16px] h-[16px] px-[4px] text-[9px]"
    : "inline-flex items-center justify-center min-w-[20px] h-[20px] px-[5px] text-[10px]";
  const look = KEYCAP_TONES[tone];
  return (
    <kbd
      className={`${cls} leading-none ${look} rounded-[4px] shadow-[0_1px_0_rgba(0,0,0,0.12),inset_0_1px_0_rgba(255,255,255,0.04)]`}
      style={{ fontFamily: KEYCAP_FONT }}
    >
      {children}
    </kbd>
  );
}
