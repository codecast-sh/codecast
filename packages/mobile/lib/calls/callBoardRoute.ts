/** The native screen a call's board opens on: never a web page. */
export function callBoardRoute(roomKey: string): { pathname: "/call-board"; params: { room: string } } {
  return { pathname: "/call-board", params: { room: roomKey } };
}
