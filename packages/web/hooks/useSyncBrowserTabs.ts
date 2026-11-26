// Feeder for the browserTabs collection: the browser tabs the viewer's
// sessions have open on every machine (convex/browserTabs.ts), read by the
// inbox's Browser view. Mounted once, in HostFeeders.
import { api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";

export function useSyncBrowserTabs(): void {
  useSyncCollection("browserTabs", api.browserTabs.webList, {});
}
