// Who owns an issue, as data: the people and roles it can go to, and the
// assign that moves its problem task (or files one). issueOwner.tsx draws
// the face and the menu over these.
import { useMemo } from "react";
import { toast } from "sonner";
import type { AssigneeInfo } from "@codecast/shared/contracts/orgAssignee";
import { useInboxStore } from "../../store/inboxStore";
import { useRolesAndPeopleOptions } from "../../hooks/useRolesAndPeopleOptions";
import { creditedTask } from "./issuesModel";
import type { OpsGroup, OpsSource } from "./opsTypes";
import { teamMembersOf } from "../../lib/activeTeam";

const NO_MEMBERS: any[] = [];

export type OwnerOption = { key: string; label: string; info: AssigneeInfo; you: boolean; section?: string };

/** The people and roles an issue can go to, the viewer first. */
export function useOwnerOptions(): OwnerOption[] {
  const teamMembers = useInboxStore((s) => teamMembersOf(s) as any[]) ?? NO_MEMBERS;
  const me = useInboxStore((s) => (s as any).currentUser?._id as string | undefined);
  const { people, roles } = useRolesAndPeopleOptions(teamMembers);
  return useMemo(() => {
    const all = [...people, ...roles].map((o) => ({ key: o.key, label: o.label, info: o.info, you: o.key === me, section: o.section }));
    return all.sort((a, b) => Number(b.you) - Number(a.you));
  }, [people, roles, me]);
}

/** An owner id as a face and a name, from the options; null for one nobody here can name. */
export function ownerInfo(options: OwnerOption[], assignee: string | null | undefined): OwnerOption | null {
  if (!assignee) return null;
  return options.find((o) => o.key === assignee) ?? null;
}

type TaskLite = { _id: string; short_id?: string; title?: string; assignee?: string };

/**
 * Hands issues to a person or role. An issue with a problem task moves that
 * task's assignee; one without files a task for it with the assignee and
 * links it. One toast names what changed, and its Undo puts the previous
 * owners back on the tasks that had one.
 */
export function assignIssues(groups: OpsGroup[], owner: OwnerOption, sources: Map<string, OpsSource>): void {
  const st = useInboxStore.getState();
  const tasks = st.tasks as Record<string, TaskLite>;
  const before: { short_id: string; assignee: string }[] = [];
  let filed = 0;
  for (const g of groups) {
    // A task filed for another title is not this issue's: assigning files the issue its own task rather than moving that one.
    const linked = g.signal_task_id ? tasks[g.signal_task_id] : undefined;
    const t = creditedTask(g, linked);
    if (t?.short_id) {
      if (t.assignee === owner.key) continue;
      before.push({ short_id: t.short_id, assignee: t.assignee ?? "" });
      void st.updateTask(t.short_id, { assignee: owner.key });
      continue;
    }
    if (g.signal_task_id && (!linked || t)) continue;
    filed++;
    const projectId = sources.get(g.source_id)?.project_id;
    void st
      .createTask({ title: `[${g.short_id}] ${g.title}`.slice(0, 200), description: `Problem from ${g.short_id}.`, assignee: owner.key, ...(projectId ? { project_id: projectId } : {}) })
      .then((res: any) => {
        const id = res?.id ?? res?._id;
        if (id) useInboxStore.getState().setOpsGroupTask(g._id, String(id));
      })
      .catch(() => toast.error(`Could not file a task for ${g.short_id}`));
  }
  const n = before.length + filed;
  if (!n) return;
  const who = owner.you ? "you" : owner.label;
  toast(n === 1 && groups.length === 1 ? `${groups[0].short_id} assigned to ${who}` : `${n} issues assigned to ${who}`, {
    id: "ops-assign",
    duration: 8000,
    description: filed ? `${filed} filed as new ${filed === 1 ? "task" : "tasks"}` : undefined,
    ...(before.length
      ? { action: { label: "Undo", onClick: () => { for (const b of before) void useInboxStore.getState().updateTask(b.short_id, { assignee: b.assignee }); } } }
      : {}),
  });
}
