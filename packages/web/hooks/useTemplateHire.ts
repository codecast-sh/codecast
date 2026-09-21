// The web's reads and writes for roles hired from a template (docs/architecture/
// org-hire.md H3, H11). One module, so the hire dialog and the role page share
// it and a mount test can stand in for the server with one mock.
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useQueryNoThrow } from "./useQueryNoThrow";

/** The templates this workspace may hire: its own and Codecast's (H1). */
export function useTemplateCatalog(teamId: string | undefined) {
  const { data, error } = useQueryNoThrow(api.orgTemplates.catalog, teamId === undefined ? {} : { team_id: teamId as Id<"teams"> });
  return { templates: (data ?? []) as any[], ready: data !== undefined, error };
}

/** The instance a role was hired as, with its record and readiness; null for an ordinary role. */
export function useTemplateInstance(roleId: string | undefined) {
  const { data, error } = useQueryNoThrow(api.orgTemplates.instanceForRole, roleId ? { role_id: roleId as Id<"org_roles"> } : "skip");
  return { instance: data as any, ready: data !== undefined, error };
}

/** The person's writes: post the hire as a proposal, mark a setup item, activate a routine. */
export function useTemplateActions() {
  const propose = useMutation(api.orgProposals.create);
  const setup = useMutation(api.orgTemplates.setup);
  const activate = useMutation(api.orgTemplates.activateRoutine);
  return {
    propose: (args: { team_id?: string; title: string; summary_md: string; mode: string; changes: unknown[]; asks: unknown[] }) => propose({ ...args, team_id: args.team_id as Id<"teams"> | undefined }) as Promise<any>,
    markSetup: (instanceKey: string, id: string, status: "done" | "open" | "skipped") => setup({ instance_key: instanceKey, id, status, from_agent: false }),
    activate: (taskId: string) => activate({ task_id: taskId as Id<"agent_tasks"> }),
  };
}
