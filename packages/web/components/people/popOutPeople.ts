import { toast } from "sonner";
import { PEOPLE_ROUTE, openPeopleWindow } from "../../lib/desktop";

/**
 * Open the buddy list, and SAY SO when a browser refuses.
 *
 * `openPeopleWindow` resolves false for exactly one reason: a popup blocker ate
 * the window. Every caller used to drop that on the floor, which made a blocked
 * popup indistinguishable from a dead button — the worst possible reading,
 * because the person tries again instead of looking at their address bar.
 *
 * The retry offered here is a plain tab rather than another popup, and it fires
 * from the toast's own click, so it carries a fresh user gesture and the
 * blocker lets it through.
 */
export async function popOutPeople(): Promise<void> {
  if (await openPeopleWindow()) return;
  toast.error("Your browser blocked the people window", {
    description: "Allow popups for this site, or open it as a tab instead.",
    action: {
      label: "Open as a tab",
      onClick: () => window.open(PEOPLE_ROUTE, "codecast-people"),
    },
  });
}
