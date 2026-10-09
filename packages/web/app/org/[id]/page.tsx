"use client";
// /org/<ref>, /org/goals, /org/projects and /org/<view>/<ref>: the Org screen
// (essence spec §3.2). A goal (`in-N`), a project (`pj-…`), a role (`or-N`)
// and a person (`@handle`) open in the screen's panel, and so do the older
// forms still in links people hold (a goal's stub key, a bare Convex id),
// which the screen moves to the short form once the store names it. `goals`
// and `projects` are reserved segments naming the two read views. /org
// renders this same screen (RoutePane, App.tsx), so opening an object
// reconciles and never remounts it. /org/workspace is the root scope and
// keeps its own page (scopes-and-feed.md F3).
import { useParams } from "next/navigation";
import { AuthGuard } from "../../../components/AuthGuard";
import { OrgFeatureGate } from "../../../components/org/OrgFeatureGate";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { ScopePageInner } from "../../../components/org/scope/ScopePage";
import { namesOrgObject } from "../../../components/org/company/objects";
import { isOrgViewSegment } from "../../../components/org/panelTarget";
import OrgScreenPage from "../page";

/** A segment that names no company object and no read view: the root scope, or a page under it. */
function isScopeSegment(id: string): boolean {
  return !isOrgViewSegment(id) && !namesOrgObject(id);
}

export default function OrgObjectPage() {
  const params = useParams() as { view?: string; id?: string } | null;
  const raw = params?.id;
  let id: string | null = null;
  try { id = raw ? decodeURIComponent(raw) : null; } catch { id = raw ?? null; }
  // A read view with an object under it is always the screen; the view is checked first.
  if (!isOrgViewSegment(params?.view) && id && isScopeSegment(id)) {
    return (
      <AuthGuard>
        <DashboardLayout>
          <OrgFeatureGate>
            <ScopePageInner id={id} />
          </OrgFeatureGate>
        </DashboardLayout>
      </AuthGuard>
    );
  }
  return <OrgScreenPage />;
}
