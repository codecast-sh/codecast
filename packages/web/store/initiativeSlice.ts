// Initiative writes (docs/architecture/initiatives-projects-role-page.md I1).
// The `initiatives` and `initiativeUpdates` collections are registered in
// clientSyncRegistry, which gives them their store slots, persistence and
// pending protection; this slice holds only the actions. Each one patches the
// draft so the page moves in the same tick, and rides `dispatch` to the side
// effect of the same name (convex/dispatch.ts), which calls the one public
// mutation the CLI also calls.
//
// A create and a posted update paint a stub keyed by the caller's
// `client_key`; the server row carrying that key supersedes it (altKey). A
// write against a stub id makes the side effect answer null and wait, so an
// edit made in the second after a create is kept locally and is not an error.
import { action } from "./mutativeMiddleware";
import { writeAsServerShape } from "./serverShape";
import { pushRoleFieldsIntent, type OrgSliceData } from "./orgSlice";
import { leadScopeChange } from "@codecast/shared/contracts/orgLead";
import type { InitiativeOwner, InitiativePriority, InitiativeRow, InitiativeStatus, InitiativeUpdateHealth, InitiativeUpdateRow } from "@codecast/shared/contracts/initiative";

/** Null clears a field, as the mutation reads it. */
export type InitiativeFields = {
  title?: string;
  description?: string | null;
  status?: InitiativeStatus;
  owner?: InitiativeOwner | null;
  target_date?: number | null;
  priority?: InitiativePriority | null;
  labels?: string[];
  parent_initiative_id?: string | null;
};

/** Writes are explicit: the caller names the workspace it is looking at. */
export type CreateInitiativeInput = Omit<InitiativeFields, "title"> & {
  client_key: string;
  title: string;
  workspace: "personal" | "team";
  team_id?: string;
  project_ids?: string[];
};

export type InitiativeSliceActions = {
  createInitiative: (input: CreateInitiativeInput) => void;
  updateInitiative: (id: string, fields: InitiativeFields) => void;
  addInitiativeProject: (id: string, projectId: string) => void;
  removeInitiativeProject: (id: string, projectId: string) => void;
  setInitiativeProjects: (id: string, projectIds: string[]) => void;
  postInitiativeUpdate: (id: string, update: { client_key: string; body: string; health: InitiativeUpdateHealth }) => void;
};

type InitiativeDraft = OrgSliceData & {
  initiatives: Record<string, InitiativeRow>;
  initiativeUpdates: Record<string, InitiativeUpdateRow>;
  currentUser?: { _id: string } | null;
};

/** Pending protection compares objects as JSON, so an owner is written with
 *  its keys in the order the server stores them: `kind` first. */
const asStored = (owner: InitiativeOwner): InitiativeOwner =>
  owner.kind === "role" ? { kind: "role", role_id: owner.role_id } : { kind: "user", user_id: owner.user_id };

const withStoredOwner = <T extends { owner?: InitiativeOwner | null }>(fields: T): T =>
  fields.owner ? { ...fields, owner: asStored(fields.owner) } : fields;

/** An owner role has every project of its initiative in its scope (I1 "The
 *  org"). The server adds them in the write's own transaction; this paints the
 *  same gain as a role fields intent, by the rule a project's lead uses, so a
 *  role that looks after the whole workspace is never narrowed to a list. */
function coverOwnerScope(draft: InitiativeDraft, initiative: InitiativeRow | undefined): void {
  const tree = draft.orgTree;
  if (!tree || initiative?.owner?.kind !== "role") return;
  const roleId = initiative.owner.role_id;
  const role = tree.roles.find((r) => r._id === roleId);
  if (!role || role.status === "retired") return;
  const gained = initiative.project_ids.filter((id) => leadScopeChange(id, role, tree.roles).kind === "add");
  if (gained.length === 0) return;
  pushRoleFieldsIntent(draft, role._id, { scope: { project_ids: [...role.scope.project_ids, ...gained], plan_ids: role.scope.plan_ids } });
}

export function createInitiativeSlice(): InitiativeSliceActions {
  return {
    createInitiative: action(function (this: InitiativeDraft, input: CreateInitiativeInput) {
      const me = String(this.currentUser?._id ?? "");
      const title = input.title.trim();
      if (!title || !me) return;
      const now = Date.now();
      const { client_key, workspace, team_id, owner, ...fields } = input;
      const stub: InitiativeRow = {
        _id: client_key,
        // The number is the server's to mint; the page opens a stub by its key.
        short_id: "",
        client_key,
        status: "proposed",
        project_ids: [],
        health: "none",
        workspace: workspace === "team" && team_id ? `team:${team_id}` : `user:${me}`,
        team_id: workspace === "team" ? team_id : undefined,
        user_id: me,
        created_at: now,
        updated_at: now,
        title,
      };
      writeAsServerShape(stub, { ...fields, title, owner: owner ? asStored(owner) : undefined });
      this.initiatives[client_key] = stub;
      coverOwnerScope(this, stub);
    }),

    updateInitiative: action(function (this: InitiativeDraft, id: string, fields: InitiativeFields) {
      const row = this.initiatives[id];
      if (!row) return;
      writeAsServerShape(row, withStoredOwner(fields));
      if (fields.owner) coverOwnerScope(this, row);
    }),

    addInitiativeProject: action(function (this: InitiativeDraft, id: string, projectId: string) {
      const row = this.initiatives[id];
      if (!row || row.project_ids.includes(projectId)) return;
      writeAsServerShape(row, { project_ids: [...row.project_ids, projectId] });
      coverOwnerScope(this, row);
    }),

    removeInitiativeProject: action(function (this: InitiativeDraft, id: string, projectId: string) {
      const row = this.initiatives[id];
      if (!row || !row.project_ids.includes(projectId)) return;
      // An empty list stays a list: `project_ids` is required on the row.
      row.project_ids = row.project_ids.filter((p) => p !== projectId);
      row.updated_at = Date.now();
    }),

    setInitiativeProjects: action(function (this: InitiativeDraft, id: string, projectIds: string[]) {
      const row = this.initiatives[id];
      if (!row) return;
      row.project_ids = [...new Set(projectIds)];
      row.updated_at = Date.now();
      coverOwnerScope(this, row);
    }),

    postInitiativeUpdate: action(function (this: InitiativeDraft, id: string, update: { client_key: string; body: string; health: InitiativeUpdateHealth }) {
      const row = this.initiatives[id];
      const me = String(this.currentUser?._id ?? "");
      const body = update.body.trim();
      if (!row || !me || !body) return;
      this.initiativeUpdates[update.client_key] = {
        _id: update.client_key,
        client_key: update.client_key,
        initiative_id: id,
        body,
        health: update.health,
        by: { kind: "user", user_id: me },
        at: Date.now(),
        workspace: row.workspace,
        user_id: me,
      };
      // `health` only: when it was said and which update said it are the
      // server's to stamp, and the registry leaves them unprotected.
      row.health = update.health;
    }),
  };
}
