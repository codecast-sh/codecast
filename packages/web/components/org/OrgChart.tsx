"use client";
// /org: the company as one chart. People, the agent roles that answer to them,
// the goals and the projects that serve them, drawn together. The chart is a
// map into the app, not a place of its own: every card opens the page that
// thing already has. A role opens its session, a person their profile, a goal
// its page and a project its board. Proposals are answered in the Head of
// People's session like any other conversation.
import { useCallback } from "react";
import { toast } from "sonner";
import { useRouter, useSearchParams } from "next/navigation";
import { objectHref } from "@codecast/shared/entities";
import { isHeadOfPeopleRole } from "@codecast/shared/contracts/orgLead";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useSyncOrgProposal } from "../../hooks/useSyncOrgProposals";
import { useInboxStore } from "../../store/inboxStore";
import { useSyncOrgTree } from "../../hooks/useSyncOrgTree";
import { useSyncProjects } from "../../hooks/useSyncProjects";
import { OrgMap } from "./OrgMap";
import type { OrgGraphObject } from "./OrgGraph";
import type { OrgParentRef } from "./orgTypes";

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

/** Older links still name a proposal (`?proposal=op-N`, its card lives in the
 *  conversation that posted it) or a message for the Head of People
 *  (`?compose=…`). Both lead to that conversation; a message waits in its
 *  composer. Null when the address names neither, or the store cannot say yet. */
function useConversationAsk(): { to: string | null; draft: string | null } {
  const params = useSearchParams();
  const proposal = params.get("proposal");
  const draft = params.get("compose");
  useSyncOrgProposal(proposal);
  const to = useInboxStore((st) => {
    if (!proposal && !draft) return null;
    const row = proposal ? Object.values((st.orgProposals ?? {}) as Record<string, { short_id?: string; thread?: { conversation_id: string } | null }>).find((p) => p.short_id === proposal) : undefined;
    const head = st.orgTree?.roles.find((r) => isHeadOfPeopleRole(r))?.standing?.conversation_id;
    return row?.thread?.conversation_id ?? head ?? null;
  });
  return { to, draft };
}

export function OrgChart() {
  const router = useRouter();
  const { tree } = useSyncOrgTree();
  useSyncProjects();
  const ask = useConversationAsk();
  useWatchEffect(() => {
    if (!ask.to) return;
    if (ask.draft) useInboxStore.getState().setDraft(ask.to, { ...(useInboxStore.getState().getDraft(ask.to) ?? {}), draft_message: ask.draft });
    router.replace(`/conversation/${ask.to}`);
  }, [ask.to]);
  const open = useCallback((o: OrgGraphObject | null) => {
    if (!o) return false;
    const href = chartCardHref(o, useInboxStore.getState());
    if (!href) return false;
    router.push(href);
    return true;
  }, [router]);
  // Drag a role onto a person or another role: it reports there from now on.
  // The store moves the card in the same tick; a refusal puts it back and says why.
  const moveRole = useCallback((roleId: string, to: OrgParentRef, toTitle: string) => {
    const name = useInboxStore.getState().orgTree?.roles.find((r) => r._id === roleId)?.name ?? "The role";
    void useInboxStore.getState().reparentOrgRole(roleId, to)
      .then((r) => { if (r) toast.success(`${name} now reports to ${toTitle}`); })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message.split("\n")[0] : `Could not move ${name}`));
  }, []);
  const openSession = useCallback((conversationId: string) => router.push(`/conversation/${conversationId}`), [router]);
  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: "var(--sol-bg)" }} data-org-chart>
      <header className="flex h-12 shrink-0 items-center border-b px-5" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 30%, transparent)" }}>
        <h1 className="text-[15px] font-medium" style={{ color: "var(--sol-text)" }}>Org</h1>
      </header>
      <div className="relative min-h-0 flex-1">
        <OrgMap tree={tree} filter="everything" asProposed={false} onAsProposed={() => {}} toolbar={false} onOpenObject={open} onOpenSession={openSession} onMoveRole={moveRole} />
      </div>
    </div>
  );
}
