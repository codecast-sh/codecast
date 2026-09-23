export function inHuddle(st: { call?: { phase?: string; roomKey?: string | null } }, walkie: typeof import("./walkie") | null = null): boolean {
  // `connected` holds through a LiveKit reconnect (callManager never demotes
  // the phase for one), so the report never flickers to "not in a call".
  if (st.call?.phase !== "connected") return false;
  if (!walkie) return true;
  return !walkie.walkieHoldsRoom(walkie.getWalkieStatus(), st.call.roomKey ?? null);
}
