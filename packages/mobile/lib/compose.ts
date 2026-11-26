import { create } from 'zustand';
import type { SessionStart } from '@codecast/web/store/composeSlice';

// The new session sheet is one per app (ComposeHost in
// components/session/NewSessionSheet, at the root), so any screen opens it:
// the inbox header, a session's header, a starter, an image shared to the app
// (lib/shareInbox). `seed` is words to start the box with and `images` local
// files to start it with attached; `start` and `task` what the session is
// linked to at creation (a milestone's Start: its priority, milestone and
// plan, the SessionStart web's composer carries, and its first open task,
// web's linkedTask); `opens` counts openings, so the host can start each one
// fresh.
export type ComposeImage = { uri: string; mime: string };
export type ComposeTask = { _id: string; short_id: string; title?: string; status?: string };
type ComposeState = { open: boolean; seed: string | null; images: ComposeImage[]; start: SessionStart | null; task: ComposeTask | null; opens: number };

export const useCompose = create<ComposeState>(() => ({ open: false, seed: null, images: [], start: null, task: null, opens: 0 }));

let landingFloor: ReturnType<typeof setTimeout> | null = null;

export function openCompose(seed: string | null = null, images: ComposeImage[] = [], start: SessionStart | null = null, task: ComposeTask | null = null) {
  useCompose.setState((s) => ({ open: true, seed, images, start, task, opens: s.opens + 1 }));
}

/**
 * What the sheet's create adds for a session born linked (createSession's
 * own args, as web's createSessionFromStub sends them): the priority,
 * milestone and plan, and the task as its linked object.
 */
export function linkedCreateArgs(start: SessionStart | null, task: ComposeTask | null): SessionStart & { linked_object?: { type: 'task'; id: string } } {
  return { ...(start ?? {}), ...(task ? { linked_object: { type: 'task' as const, id: task._id } } : {}) };
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
