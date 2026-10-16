import { useInboxStore } from "../store/inboxStore";
import { useHostedMode } from "../lib/surfaces";
import { useIsPhone } from "./useIsPhone";
import { useDesktopAppWindow } from "./useDesktopWindowRole";

/**
 * Whether this window draws the space rail (lib/navSpaces). The main window on
 * a desktop-sized screen does; hosted mode keeps its own single rail, an app
 * window (Chat, Work) is one space already, a phone opens the whole nav as a
 * drawer, and zen mode draws no chrome at the edge.
 *
 * The chat page asks too: with spaces on, the sidebar column never lists
 * rooms, so the page's own room list is the Chat space's column.
 */
export function useNavSpacesOn(): boolean {
  const hosted = useHostedMode();
  const appWindow = useDesktopAppWindow();
  const phone = useIsPhone();
  const zen = useInboxStore((s) => s.clientState.ui?.zen_mode ?? false);
  return !hosted && !appWindow && !phone && !zen;
}
