import { toast } from "sonner";
import { PEOPLE_ROUTE, bridge, canOpenFacesOverlay, openFacesWindow } from "../../lib/desktop";
import { popOutWindow } from "../../lib/popOut";

/**
 * Open the buddy list in a window of its own, and SAY SO when it cannot be the
 * window it should be.
 *
 * The ladder lives in lib/popOut (shell window → detached tab window → browser
 * popup); this adds the two sentences a person needs when a rung is missing.
 * Both failures used to be silent, and each read as a dead button: a blocked
 * popup made people press again instead of looking at the address bar, and an
 * old desktop build quietly opened a Chrome window beside the app.
 *
 * The retry offered on a blocked popup is a plain tab rather than another
 * popup, and it fires from the toast's own click, so it carries a fresh user
 * gesture and the blocker lets it through.
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
  const outcome = await popOutWindow(PEOPLE_ROUTE, bridge("openPeopleWindow"), {
    name: "codecast-people",
    width: 320,
    height: 640,
  });
  if (outcome === "needs-update") {
    toast.error("The desktop app needs an update for this", {
      description: "This build cannot open the people window. Update Codecast and it opens in a window of its own.",
    });
    return;
  }
  if (outcome === "blocked") {
    toast.error("Your browser blocked the people window", {
      description: "Allow popups for this site, or open it as a tab instead.",
      action: {
        label: "Open as a tab",
        onClick: () => window.open(PEOPLE_ROUTE, "codecast-people"),
      },
    });
  }
}
