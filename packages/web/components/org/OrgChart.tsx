"use client";
// /org: the company as one chart. People, the agent roles that answer to them,
// the goals and the projects that serve them, drawn together. The chart is a
// map into the app, not a place of its own: every card opens the page that
// thing already has. A role opens its session, a person their profile, a goal
// its page and a project its board. Proposals are answered in the Head of
// People's session like any other conversation.
import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { objectHref } from "@codecast/shared/entities";
import { useInboxStore } from "../../store/inboxStore";
import { useSyncOrgTree } from "../../hooks/useSyncOrgTree";
import { useSyncProjects } from "../../hooks/useSyncProjects";
import { OrgMap } from "./OrgMap";
import type { OrgGraphObject } from "./OrgGraph";

/** The page a chart card opens, or null when the store cannot name one yet. */
export function chartCardHref(o: OrgGraphObject, st: ReturnType<typeof useInboxStore.getState>): string | null {
  if (o.kind === "role") {
    const role = st.orgTree?.roles.find((r) => r._id === o.id || r.short_id === o.id);
    const conv = role?.standing?.conversation_id;
    return conv ? `/conversation/${conv}` : null;
  }
  if (o.kind === "person") {
    const member = (st.teamMembers as Array<{ _id: string; github_username?: string }> | undefined)?.find((m) => String(m._id) === o.id);
    return `/team/${encodeURIComponent(member?.github_username || o.id)}`;
  }
  if (o.kind === "initiative") {
    const goal = (st.initiatives as Record<string, { short_id?: string }> | undefined)?.[o.id];
    return objectHref("initiative", goal?.short_id || o.id);
  }
  const project = (st.projects as Record<string, { short_id?: string }> | undefined)?.[o.id];
  return objectHref("project", project?.short_id || o.id);
}

export function OrgChart() {
  const router = useRouter();
  const { tree } = useSyncOrgTree();
  useSyncProjects();
  const open = useCallback((o: OrgGraphObject | null) => {
    if (!o) return false;
    const href = chartCardHref(o, useInboxStore.getState());
    if (!href) return false;
    router.push(href);
    return true;
  }, [router]);
  const openSession = useCallback((conversationId: string) => router.push(`/conversation/${conversationId}`), [router]);
  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: "var(--sol-bg)" }} data-org-chart>
      <header className="flex h-12 shrink-0 items-center border-b px-5" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 30%, transparent)" }}>
        <h1 className="text-[15px] font-medium" style={{ color: "var(--sol-text)" }}>Org</h1>
      </header>
      <div className="relative min-h-0 flex-1">
        <OrgMap tree={tree} filter="everything" asProposed={false} onAsProposed={() => {}} toolbar={false} onOpenObject={open} onOpenSession={openSession} />
      </div>
    </div>
  );
}
