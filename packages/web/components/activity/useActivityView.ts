// The Activity page's view as the page holds it: the address when it
// names a field (a link is a view), else the person's last grouping (the ui
// prefs bag), and every change written to the address, the grouping to the
// prefs too, the way the decision and task lists keep theirs.
import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useInboxStore, type ClientUI } from "../../store/inboxStore";
import { activityViewHref, defaultScope, parseActivityView, type ActivityTab, type ActivityView } from "./activityView";

// The grouping rides the ui prefs bag under its own key. ClientUI is a closed
// type kept in inboxStore.ts; every key there is stamped and synced unless
// listed per device, so this one persists without a line in that file.
type ActivityPrefs = { activity_view?: { group?: string } };

export type ActivityViewState = {
  view: ActivityView;
  set: (patch: Partial<ActivityView>) => void;
  /** The address of another tab, carrying whose work it shows. */
  tabHref: (tab: ActivityTab) => string;
};

export function useActivityView(tab: ActivityTab, hasTeam: boolean): ActivityViewState {
  const params = useSearchParams();
  const router = useRouter();
  const savedGroup = useInboxStore((s) => (s.clientState.ui as ActivityPrefs | undefined)?.activity_view?.group);
  const updateClientUI = useInboxStore((s) => s.updateClientUI);
  const view = useMemo(() => parseActivityView(params, { tab, hasTeam, savedGroup }), [params, tab, hasTeam, savedGroup]);

  const set = useCallback((patch: Partial<ActivityView>) => {
    const next = { ...view, ...patch };
    if (patch.group && patch.group !== savedGroup) updateClientUI({ activity_view: { group: patch.group } } as Partial<ClientUI>);
    router.replace(activityViewHref(next, hasTeam));
  }, [view, savedGroup, updateClientUI, router, hasTeam]);

  // A scope the person chose travels with them; a tab's own default does not.
  const chose = !!params?.get("filter");
  const tabHref = useCallback(
    (to: ActivityTab) => activityViewHref({ ...view, tab: to, scope: chose ? view.scope : defaultScope(to, hasTeam), people: [], project: null, needs: false }, hasTeam),
    [view, hasTeam, chose],
  );

  return { view, set, tabHref };
}
