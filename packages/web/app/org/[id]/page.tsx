"use client";
// /org/<ref>: an address under Org leads to the page that thing has. A role
// is its session, a person their profile, a goal and a project their own
// pages; the old list addresses (/org/goals, /org/projects) are the lists.
// /org/workspace is the root scope and keeps its own page (scopes-and-feed.md
// F3). Anything else is the chart.
import { useParams, useRouter } from "next/navigation";
import { objectHref, orgObjectOfRef } from "@codecast/shared/entities";
import { useInboxStore } from "../../../store/inboxStore";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { OrgTreeFeeder } from "../../../components/inbox/InboxEffects";
import { AuthGuard } from "../../../components/AuthGuard";
import { OrgFeatureGate } from "../../../components/org/OrgFeatureGate";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { ScopePageInner } from "../../../components/org/scope/ScopePage";
import OrgPage from "../page";

/** Where an address under Org leads, or null for the chart. A role the store
 *  has not loaded yet is "wait": its session is not known until the tree is. */
function homeOf(view: string | undefined, id: string | null, st: ReturnType<typeof useInboxStore.getState>): string | "wait" | null {
  if (view === "goals" || id === "goals") return view === "goals" && id ? objectHref("initiative", id) : "/goals";
  if (view === "projects" || id === "projects") return view === "projects" && id ? objectHref("project", id) : "/projects";
  if (!id) return null;
  const object = orgObjectOfRef(id);
  if (!object) return null;
  if (object.kind === "initiative" || object.kind === "project") return objectHref(object.kind, object.ref);
  if (object.kind === "person") return `/team/${encodeURIComponent(object.ref)}`;
  if (!st.orgTree) return "wait";
  const conv = st.orgTree.roles.find((r) => r.short_id?.toLowerCase() === object.ref)?.standing?.conversation_id;
  return conv ? `/conversation/${conv}` : null;
}

function GoHome({ to }: { to: string }) {
  const router = useRouter();
  useWatchEffect(() => { router.replace(to); }, [to]);
  return null;
}

export default function OrgObjectPage() {
  const params = useParams() as { view?: string; id?: string } | null;
  let id: string | null = null;
  try { id = params?.id ? decodeURIComponent(params.id) : null; } catch { id = params?.id ?? null; }
  const home = useInboxStore((st) => homeOf(params?.view, id, st));
  if (home === "wait") return <OrgTreeFeeder />;
  if (home) return <GoHome to={home} />;
  if (id === "workspace") {
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
  return <OrgPage />;
}
