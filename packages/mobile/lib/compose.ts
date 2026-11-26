import { create } from 'zustand';
import type { SessionStart } from '@codecast/web/store/composeSlice';

// The new session sheet is one per app (ComposeHost in
// components/session/NewSessionSheet, at the root), so any screen opens it:
// the inbox header, a session's header, a starter, an image shared to the app
// (lib/shareInbox). `seed` is words to start the box with and `images` local
// files to start it with attached; `start` what the session is linked to at
// creation (a milestone's Start: its priority, milestone and plan, the
// SessionStart web's composer carries); `opens` counts openings, so the host
// can start each one fresh.
export type ComposeImage = { uri: string; mime: string };
type ComposeState = { open: boolean; seed: string | null; images: ComposeImage[]; start: SessionStart | null; opens: number };

export const useCompose = create<ComposeState>(() => ({ open: false, seed: null, images: [], start: null, opens: 0 }));

let landingFloor: ReturnType<typeof setTimeout> | null = null;

export function openCompose(seed: string | null = null, images: ComposeImage[] = [], start: SessionStart | null = null) {
  useCompose.setState((s) => ({ open: true, seed, images, start, opens: s.opens + 1 }));
}

export function closeCompose() {
  if (landingFloor) clearTimeout(landingFloor);
  landingFloor = null;
  useCompose.setState({ open: false });
}

/** A session was started from the sheet and is being pushed under it. The
 *  session screen closes the sheet from its first render (sessionLanded), so
 *  the sheet slides off the new session rather than the screen it was opened
 *  over; the floor closes it anyway should that render never come. */
export function awaitSessionLanding() {
  if (landingFloor) clearTimeout(landingFloor);
  landingFloor = setTimeout(closeCompose, 1500);
}

export function sessionLanded() {
  if (useCompose.getState().open) closeCompose();
}
