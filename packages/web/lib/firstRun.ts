// The inbox's first run, for the surfaces that care: the inbox shows the
// two-start card on "yes", and the dialogs that open unasked (device setup,
// the inbox tour) stay out of the way until "no". The reading itself is
// store/firstRunState.ts, which the store's create path shares: a first
// conversation with the hosted assistant from there moves the person to
// hosted mode (createSessionFromStub).
import { useInboxStore } from "../store/inboxStore";
import { firstRun, type FirstRun } from "../store/firstRunState";

export { firstRun, type FirstRun };

export const useFirstRun = (): FirstRun => useInboxStore(firstRun);
