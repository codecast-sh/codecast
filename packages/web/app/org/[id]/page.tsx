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
import { useParams, useRouter } from "next/navigation";
import { objectHref, orgObjectOfRef } from "@codecast/shared/entities";
import { useInboxStore } from "../../../store/inboxStore";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { OrgTreeFeeder } from "../../../components/inbox/InboxEffects";
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

/** Where an object that has a page of its own lives instead: a role is its
 *  session, a goal and a project their own pages. Null for anything the Org
 *  screen shows itself, and while the store does not know the role yet. */
function homeOf(id: string, st: ReturnType<typeof useInboxStore.getState>): string | null {
  const object = orgObjectOfRef(id);
  if (object?.kind === "initiative" || object?.kind === "project") return objectHref(object.kind, object.ref);
  if (object?.kind !== "role") return null;
  const role = st.orgTree?.roles.find((r) => r.short_id?.toLowerCase() === object.ref);
  const conv = role?.standing?.conversation_id;
  return conv ? `/conversation/${conv}` : null;
}

/** Sends a role to its session and a goal or project to its page, replacing the address. */
function GoHome({ to }: { to: string }) {
  const router = useRouter();
  useWatchEffect(() => { router.replace(to); }, [to]);
  return null;
}

export default function OrgObjectPage() {
  const params = useParams() as { view?: string; id?: string } | null;
  const raw = params?.id;
  let id: string | null = null;
  try { id = raw ? decodeURIComponent(raw) : null; } catch { id = raw ?? null; }
  const home = useInboxStore((st) => (id ? homeOf(id, st) : null));
  if (home) return <GoHome to={home} />;
  // A role the store has not loaded yet: load the tree and wait, rather than flash the screen.
  if (id && orgObjectOfRef(id)?.kind === "role") return <AuthGuard><DashboardLayout><OrgTreeFeeder /><RoleWithoutSession id={id} /></DashboardLayout></AuthGuard>;
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

/** A role whose session the store has not named yet: the screen once the tree
 *  has loaded and still names none, nothing before. */
function RoleWithoutSession({ id }: { id: string }) {
  const loaded = useInboxStore((st) => !!st.orgTree);
  return loaded ? <OrgScreenPage /> : null;
}
