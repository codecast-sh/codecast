// The web's reads and writes for roles hired from a template (docs/architecture/
// org-hire.md H3, H11). One module, so the hire dialog and the role page share
// it and a mount test can stand in for the server with one mock.
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useQueryNoThrow } from "./useQueryNoThrow";

/** Dev builds only: a fixture set from the console stands in for the server
 *  (`window.__orgTemplateFixture = { catalog?: [...], instance?: {...} }`), so the
 *  gallery and the host step can be looked at with data the deployment does not
 *  hold. Read at render; set it before opening the dialog or the role page. */
function fixture(): { catalog?: any[]; instance?: any } | null {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  if ((window as any).__orgTemplateFixture) return (window as any).__orgTemplateFixture;
  // The same fixture as JSON in localStorage survives a navigation to a role page.
  try { const raw = window.localStorage.getItem("__orgTemplateFixture"); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/** The templates this workspace may hire: its own and Codecast's (H1). */
export function useTemplateCatalog(teamId: string | undefined) {
  const { data, error } = useQueryNoThrow(api.orgTemplates.catalog, teamId === undefined ? {} : { team_id: teamId as Id<"teams"> });
  const fx = fixture();
  if (fx?.catalog) return { templates: fx.catalog as any[], ready: true, error: undefined };
  return { templates: (data ?? []) as any[], ready: data !== undefined, error };
}

/** The instance a role was hired as, with its record and readiness; null for an ordinary role. */
export function useTemplateInstance(roleId: string | undefined) {
  const { data, error } = useQueryNoThrow(api.orgTemplates.instanceForRole, roleId ? { role_id: roleId as Id<"org_roles"> } : "skip");
  const fx = fixture();
  if (fx && "instance" in fx) return { instance: fx.instance as any, ready: true, error: undefined };
  return { instance: data as any, ready: data !== undefined, error };
}

/** The person's writes: post the hire as a proposal, mark a setup item, activate a routine, run the host step. */
export function useTemplateActions() {
  const propose = useMutation(api.orgProposals.create);
  const setup = useMutation(api.orgTemplates.setup);
  const activate = useMutation(api.orgTemplates.activateRoutine);
  const bind = useMutation(api.orgTemplates.requestBind);
  return {
    propose: (args: { team_id?: string; title: string; summary_md: string; mode: string; changes: unknown[]; asks: unknown[] }) => propose({ ...args, team_id: args.team_id as Id<"teams"> | undefined }) as Promise<any>,
    markSetup: (instanceKey: string, id: string, status: "done" | "open" | "skipped") => setup({ instance_key: instanceKey, id, status, from_agent: false }),
    activate: (taskId: string) => activate({ task_id: taskId as Id<"agent_tasks"> }),
    /** The host step (H3): the daemon on the machine with the checkout runs bind. Secrets are sealed
     *  to that machine's key in the browser (sealSecret) before they reach here; never a plain value. */
    requestBind: (instanceKey: string, secrets: { key: string; payload: { provider: string; epk: string; iv: string; ct: string } }[], deviceId?: string) => bind({ instance_key: instanceKey, secrets, ...(deviceId ? { device_id: deviceId } : {}) }) as Promise<{ command_id: string; device: { device_id: string; label: string }; already_pending: boolean }>,
  };
}

/** Seal one secret input's value to the target machine's public key (H4): the same transport as a provider key, keyed by the input. */
export async function sealSecret(pubkey: string, key: string, value: string) {
  const { encryptProviderKey } = await import("../lib/providerKeyCrypto");
  return { key, payload: await encryptProviderKey(pubkey, key, value) };
}
