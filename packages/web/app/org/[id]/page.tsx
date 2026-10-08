"use client";
// /org and /org/<ref>: the Org screen, with the sheet of the object the
// address names open over the company (cohesive build spec §3.3). A goal
// (`in-N`), a project (`pj-…`), a role (`or-N`) and a person (`@handle`) each
// open here, and so do the older forms still in links people hold (a goal's
// stub key, a bare Convex id), which the screen moves to the short form once
// the store names it. /org renders this same page (RoutePane, App.tsx), so
// opening a sheet reconciles and never remounts the screen. /org/workspace
// is the root scope and keeps its own page (scopes-and-feed.md F3).
import { useParams } from "next/navigation";
import { orgObjectOfRef } from "@codecast/shared/entities";
import { AuthGuard } from "../../../components/AuthGuard";
import { OrgFeatureGate } from "../../../components/org/OrgFeatureGate";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { ScopePageInner } from "../../../components/org/scope/ScopePage";
import { isConvexId } from "../../../lib/entityLinks";
import { isInitiativeKey } from "../../../lib/initiatives";
import OrgScreenPage from "../page";

/** A segment that names no company object: the root scope, or a page under it. */
function isScopeSegment(id: string): boolean {
  return !orgObjectOfRef(id) && !isInitiativeKey(id) && !isConvexId(id);
}

export default function OrgObjectPage() {
  const params = useParams();
  const raw = params?.id as string | undefined;
  let id: string | null = null;
  try { id = raw ? decodeURIComponent(raw) : null; } catch { id = raw ?? null; }
  if (id && isScopeSegment(id)) {
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
