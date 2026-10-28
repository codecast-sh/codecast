// The Decisions list's view as the page holds it: the address when it names
// any field (a link is a view), else the person's last view (the ui prefs
// bag), and every change written to both, the way the task list keeps its
// own. A scoped list (Flows' For you) keeps its view for as long as it is
// open and never rewrites the page's. Saved views store the same fields.
import { useCallback, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useInboxStore } from "../store/inboxStore";
import { sharePageUrl } from "../lib/utils";
import { VIEW_ID_KEY } from "../lib/savedViews";
import { decisionView, viewFields, VIEW_FIELDS, type DecisionView } from "../lib/decisions/decisionRows";

export type DecisionViewState = {
  view: DecisionView;
  /** The stored fields (what a saved view compares and keeps), the open saved view's id included. */
  prefs: Record<string, string>;
  set: (patch: Partial<DecisionView>) => void;
  /** Replace the whole view: restoring a saved one has to drop the fields it does not carry. */
  replace: (prefs: Record<string, string>) => void;
  shareUrl: () => string;
};

export function useDecisionView(opts: { scoped?: Partial<DecisionView> } = {}): DecisionViewState {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() ?? "/decisions";
  const saved = useInboxStore((s) => s.clientState.ui?.decision_view);
  const updateClientUI = useInboxStore((s) => s.updateClientUI);
  const [scopedPrefs, setScopedPrefs] = useState<Record<string, string>>(() => viewFields(decisionView(opts.scoped ?? {})));
  const scoped = !!opts.scoped;

  const fromUrl = useMemo(() => {
    const out: Record<string, string> = {};
    for (const f of VIEW_FIELDS) { const v = params?.get(f); if (v) out[f] = v; }
    return out;
  }, [params]);
  const onList = pathname === "/decisions";
  const prefs = useMemo<Record<string, string>>(
    () => (scoped ? scopedPrefs : onList && Object.keys(fromUrl).length > 0 ? { ...fromUrl, ...(saved?.[VIEW_ID_KEY] ? { [VIEW_ID_KEY]: saved[VIEW_ID_KEY] } : {}) } : (saved ?? {})),
    [scoped, scopedPrefs, onList, fromUrl, saved],
  );
  const view = useMemo(() => decisionView(prefs), [prefs]);

  const replace = useCallback((next: Record<string, string>) => {
    if (scoped) { setScopedPrefs(next); return; }
    updateClientUI({ decision_view: next });
    if (onList) {
      // The page's own mode (cards) rides along; it is not part of the view.
      const mode = params?.get("mode");
      const qs = new URLSearchParams({ ...viewFields(decisionView(next)), ...(mode ? { mode } : {}) }).toString();
      router.replace(qs ? `/decisions?${qs}` : "/decisions");
    }
  }, [scoped, updateClientUI, onList, router, params]);

  const set = useCallback((patch: Partial<DecisionView>) => {
    const next = { ...view, ...patch };
    // A new tab starts from that tab's grouping; a new sort from its own direction.
    if (patch.tab && patch.group === undefined) { next.group = decisionView({ tab: patch.tab }).group; next.sub = "none"; }
    if (patch.sort && patch.dir === undefined) next.dir = decisionView({ sort: patch.sort }).dir;
    if (patch.group === "none") next.sub = "none";
    const fields = viewFields(decisionView(next));
    replace(prefs[VIEW_ID_KEY] ? { ...fields, [VIEW_ID_KEY]: prefs[VIEW_ID_KEY] } : fields);
  }, [view, prefs, replace]);

  const shareUrl = useCallback(() => {
    const qs = new URLSearchParams(viewFields(view)).toString();
    return sharePageUrl(`/decisions${qs ? `?${qs}` : ""}`);
  }, [view]);

  return { view, prefs, set, replace, shareUrl };
}
