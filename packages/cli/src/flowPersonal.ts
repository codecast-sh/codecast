// The personal Ship's part of `cast flow run` (flows.md FL2, FL4): which other sessions a run's change comes from, so
// the checkout is established as personal only when each is stamped personal too; whether the flow a run found is the
// shipped personal Ship (or built on it), which runs only where personal is established; and the refusals when it may
// not run. directoryTeam.ts decides whether a checkout is personal; this module only applies that to a run.
import * as path from "node:path";
import { PERSONAL_FLOW_SLUG } from "@codecast/shared/contracts/flowPool";
import { reachesShippedFlow } from "./workflow/parser.js";
import { runSubjects, shippedPersonalRefusal, type DirectoryWorkspace } from "./directoryTeam.js";
import type { FlowDeps } from "./flowCommand.js";
import type { FoundFlow } from "./flowFind.js";
import type { ResolvedWorkflowSource } from "./workflow/templates.js";

/** The sessions the change comes from besides this one, which must be stamped personal too for it to ship personal;
 *  a task it runs on or a session's binding that is a team's rules it out (read only once the checkout reads personal). */
export function flowRunSubjects(deps: Pick<FlowDeps, "cliPost" | "callingSession" | "pulseSession">, opts: { task?: string; session?: string | boolean }): () => Promise<string[]> {
  const session = typeof opts.session === "string" ? opts.session : undefined;
  return runSubjects({
    post: (route, body) => deps.cliPost(route, body, { throwOnError: true }),
    task: opts.task,
    session,
    pulseIds: [deps.callingSession(), deps.pulseSession?.(), session],
  });
}

/** Whether the flow a run found ships through the shipped personal Ship, and why it must not run when it does and the
 *  checkout is not established as personal. A team's own `personal` is not the shipped one and still runs. */
export function personalShipOf(found: Pick<FoundFlow, "slug" | "file" | "source" | "where">, cwd: string, personal: boolean): { ships: boolean; refusal: string | null } {
  const ships = reachesShippedFlow(found.source, found.file ? path.dirname(found.file) : cwd, PERSONAL_FLOW_SLUG);
  const is = found.slug === PERSONAL_FLOW_SLUG && found.where === "shipped" ? "is" : "is built on";
  return { ships, refusal: ships && !personal ? `${found.slug} ${is} the personal Ship, and this checkout is not established as personal (a team shares it, or that cannot be told): run change` : null };
}

/** Why the personal Ship must not run on the task a run lands on: it is a team's, or cannot be read (a binding the
 *  pulse read in flowRunSubjects missed). Null to run. */
export async function personalTaskRefusal(deps: Pick<FlowDeps, "cliPost">, task: string): Promise<string | null> {
  const row = await deps.cliPost("/cli/work/get", { short_id: task }).catch(() => null);
  return !row || row.team_id ? `This session is bound to ${task}, a team's task (or one that cannot be read), but no team shares this checkout: name the team with --team, or unbind the task` : null;
}

/** The `cast workflow run` a flow run starts. A flow that ships through the personal Ship (personalShipOf) goes
 *  with --personal-established: this run already established the checkout as personal, so the run it starts never
 *  decides that again in its own world. */
export function workflowRunArgs(found: Pick<FoundFlow, "slug" | "file">, task: string, shipsPersonal: boolean): string[] {
  return ["workflow", "run", found.file ?? found.slug, "--task", task, ...(shipsPersonal ? ["--personal-established"] : [])];
}

/** Why `cast workflow run`, typed by hand, must not run a workflow: it is the shipped personal Ship, or built on it,
 *  and this checkout is not established as personal (directoryTeam.ts shippedPersonalRefusal). A run `cast flow run`
 *  started decided this where it was decided and passes --personal-established instead. Null to run. */
export async function workflowRunRefusal(resolved: ResolvedWorkflowSource, io: {
  post: (route: string, body: Record<string, unknown>) => Promise<any>; task?: string; pulseIds: ReadonlyArray<string | null | undefined>;
  where: (subjects: () => Promise<string[]>) => Promise<DirectoryWorkspace>;
}): Promise<string | null> {
  const ships = resolved.label === `builtin:${PERSONAL_FLOW_SLUG}` || reachesShippedFlow(resolved.source, resolved.dir, PERSONAL_FLOW_SLUG);
  const subjects = runSubjects({ post: io.post, task: io.task, pulseIds: io.pulseIds });
  return shippedPersonalRefusal(ships, () => io.where(subjects));
}
