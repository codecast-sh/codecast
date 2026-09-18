// "Has the server confirmed this caller yet?" — the gate every authenticated
// feeder waits on.
//
// There are two auth signals in this stack, and they answer different
// questions (see @platform/auth/web's localAuth). The LOCAL signal flips as
// soon as a JWT is readable from storage, works offline, and is the one that
// decides what to DRAW: the app boots from the hydrated store with no round
// trip. The SERVER signal (convex/react's useConvexAuth) additionally waits
// for the backend to validate that token over the websocket, and it is the one
// that decides when to ISSUE an authenticated call.
//
// Boot crosses those two in order: AuthGuard releases the tree on the local
// signal, so every feeder mounts while the websocket is still unauthenticated.
// A query whose handler calls requireUser then throws UNAUTHENTICATED, and the
// feeder layer reports that to Sentry — a real ordering bug that looked like a
// production error every time anyone loaded /inbox (JAVASCRIPT-REACT-5Q/5P).
// An anonymous share viewer produced the same throw forever, since the shell's
// workspace feeders mount for a guest too.
//
// The answer LATCHES. A mid-session token refresh can drop isAuthenticated for
// a frame; un-gating on that would unsubscribe every feeder and re-push every
// collection into the store (and into IndexedDB) when it came back. A
// definitive sign-out unmounts the tree through AuthGuard instead, so nothing
// here has to un-latch it.
import { useRef } from "react";
import { useConvexAuth } from "convex/react";

/** The latch itself, so its rule is testable without a renderer. */
export function authSettledLatch(settled: boolean, isAuthenticated: boolean): boolean {
  return settled || isAuthenticated;
}

export function useServerAuthSettled(): boolean {
  // useConvexAuth THROWS when no auth provider is an ancestor — it does not
  // report "not authenticated". A tree that mounts a feeder under a plain
  // ConvexProvider (the hibernation harness, _chatpage, any embed) would then
  // crash on render instead of degrading, which is a far worse failure than
  // the UNAUTHENTICATED reports this gate exists to stop. Where there is no
  // auth handshake there is no race to protect against, so a missing provider
  // reads as settled and the feeder subscribes exactly as it did before.
  //
  // The hook count is stable either way: useConvexAuth reads its context
  // before it decides to throw, so this branch costs the same one useContext
  // on every render and hook order never shifts.
  let isAuthenticated = true;
  try {
    isAuthenticated = useConvexAuth().isAuthenticated;
  } catch {
    isAuthenticated = true;
  }
  const settled = useRef(false);
  // useConvexAuth re-renders us when it flips, so reading the latch in the
  // same pass it is written is enough — no effect, no extra commit.
  settled.current = authSettledLatch(settled.current, isAuthenticated);
  return settled.current;
}
