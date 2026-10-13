import { create } from 'zustand';

// The new session sheet is one per app (ComposeHost in
// components/session/NewSessionSheet, at the root), so any screen opens it:
// the inbox header, a session's header, a starter, another tab's `?ask=`
// link. `seed` is words to start the box with; `opens` counts openings, so
// the host can start each one fresh.
type ComposeState = { open: boolean; seed: string | null; opens: number };

export const useCompose = create<ComposeState>(() => ({ open: false, seed: null, opens: 0 }));

export function openCompose(seed: string | null = null) {
  useCompose.setState((s) => ({ open: true, seed, opens: s.opens + 1 }));
}

export function closeCompose() {
  useCompose.setState({ open: false });
}
