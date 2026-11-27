// Which banner the phone's call board shows (pl-1145): the invite while
// Scribe is absent, then once Scribe is invited from it the "Next time in
// <workspace>" banner, which a person sees once per workspace, ever
// (clientState.ui.huddleNextTimeSeen, the key web uses). No React Native
// here, so the rule is tested directly.

export const INVITE_WORDS = "Scribe can diagram your huddles as you talk";

/** What this person did with the banners in this call, held for the call. */
export type PhoneBannerMemo = { dismissed?: true; invited?: true; nextShown?: true; nextClosed?: true };

export function phoneBannerState(opts: { present: boolean; memo: PhoneBannerMemo; nextSeen: boolean }): "invite" | "next" | null {
  const { present, memo } = opts;
  if (!present) return memo.dismissed ? null : "invite";
  // Seen marks on first show; this call keeps it up until it is acted on.
  if (memo.invited && !memo.nextClosed && (memo.nextShown || !opts.nextSeen)) return "next";
  return null;
}

export function readNextTimeSeen(ui: unknown, workspace: string | null): boolean {
  return !!workspace && (ui as { huddleNextTimeSeen?: Record<string, boolean> } | undefined)?.huddleNextTimeSeen?.[workspace] === true;
}

/** The clientState.ui patch that marks the "Next time" banner seen in one workspace. */
export function nextTimeSeenPatch(ui: unknown, workspace: string): { huddleNextTimeSeen: Record<string, boolean> } {
  return { huddleNextTimeSeen: { ...(ui as { huddleNextTimeSeen?: Record<string, boolean> } | undefined)?.huddleNextTimeSeen, [workspace]: true } };
}
