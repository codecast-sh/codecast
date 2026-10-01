import { useRef } from "react";
import { useConvex } from "convex/react";
import { guestDoorActions } from "../lib/calls/guestDoorActions";

/** The room's gestures on a guest, bound to this client. */
export function useGuestDoor() {
  const convex = useConvex();
  // One object per client: the actions close over nothing that moves.
  const ref = useRef<ReturnType<typeof guestDoorActions> | null>(null);
  if (!ref.current) ref.current = guestDoorActions(convex);
  return ref.current;
}
