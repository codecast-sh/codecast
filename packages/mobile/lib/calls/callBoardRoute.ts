/** The native screen a call's board opens on: never a web page. */
export function callBoardRoute(roomKey: string): { pathname: "/call-board"; params: { room: string } } {
  return { pathname: "/call-board", params: { room: roomKey } };
}

/** The Board button shows only in a connected call that is being transcribed:
 *  the board and Scribe both belong to the live transcript, so without one
 *  the screen could only say there is none. */
export function boardButtonRoom(phase: string, roomKey: string | null, live: { transcript_id?: string } | null | undefined): string | null {
  return phase === "connected" && roomKey && live?.transcript_id ? roomKey : null;
}
