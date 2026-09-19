import { toast } from "sonner";
import { PEOPLE_ROUTE, bridge, canOpenFacesOverlay, openFacesWindow } from "../../lib/desktop";
import { explainPopOut, popOutWindow } from "../../lib/popOut";

/**
 * Open the buddy list in a window of its own, and SAY SO when it cannot be the
 * window it should be. The ladder lives in lib/popOut (shell window → detached
 * tab window → browser popup); explainPopOut adds the sentences a person needs
 * when a rung is missing.
 */
export async function popOutPeople(opts: { list?: boolean } = {}): Promise<void> {
  // THE FLOATING FACES ARE THE DEFAULT. Popping the team out means "keep them
  // over my work", and a see-through row of faces is that with no window
  // around it. The buddy list is the shell's fallback and one click away from
  // the overlay's own chrome (`list: true` asks for it outright).
  if (!opts.list && canOpenFacesOverlay()) {
    await openFacesWindow();
    return;
  }
  const popup = { name: "codecast-people", width: 320, height: 640 };
  const outcome = await popOutWindow(PEOPLE_ROUTE, bridge("openPeopleWindow"), popup);
  explainPopOut(outcome, { thing: "the people window", route: PEOPLE_ROUTE, name: popup.name }, toast);
}
