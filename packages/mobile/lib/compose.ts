import { create } from 'zustand';

// The new session sheet is one per app (components/session/ComposeHost, at
// the root), so any screen opens it: the inbox header, a session's header, a
// starter, another tab's `?ask=` link. `seed` is words to start the box with.
type ComposeState = { open: boolean; seed: string | null };

export const useCompose = create<ComposeState>(() => ({ open: false, seed: null }));

export function openCompose(seed: string | null = null) {
  useCompose.setState({ open: true, seed });
}

export function closeCompose() {
  useCompose.setState({ open: false });
}
