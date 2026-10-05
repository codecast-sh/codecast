import { createContext, useContext, useMemo } from "react";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { useRepoObject } from "../hooks/useRepoObject";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { entityRoute, isConvexId, entityTypeFromId, entityReferenceLabel, entityShortLabel, parseRepoObjectId, parseCallRef, callRefId, callRefLabelSuffix, type EntityType } from "./entityLinks";
import { repoObjectRefOf, repoObjectTitle } from "./repoObjects";
import { findEntityInStore, entityTypeInStore, resolveAssigneeInfo } from "./liveEntities";
import { useInboxStore } from "../store/inboxStore";
import { useSyncOrgProposal } from "../hooks/useSyncOrgProposals";
const api = _api as any;


// The shared vocabulary of inline object references: status and type maps,
// the small display atoms (avatars, summaries, relative time), and the
// resolution hook that turns a raw id into a live entity. EntityIdPill (the
// inline pill + hover card) and EntityObjectCard (the shared-object preview
// card) both build on exactly these, so an object reads the same wherever it
// appears.

// Task status glyph/color/label come from the canonical TASK_STATUS vocabulary
// (TaskStatusBadge, via `taskVisual`). The maps below cover PLAN statuses only.
export const STATUS_COLOR: Record<string, string> = {
  draft: "text-gray-400",
  done: "text-sol-green",
  dropped: "text-gray-500",
  active: "text-sol-green",
  paused: "text-sol-yellow",
  abandoned: "text-gray-500",
};


export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  done: "Done",
  dropped: "Dropped",
  active: "Active",
  paused: "Paused",
  abandoned: "Abandoned",
};


export const TYPE_LABEL: Record<EntityType, string> = {
  task: "Task",
  plan: "Plan",
  session: "Session",
  doc: "Doc",
  project: "Project",
  initiative: "Initiative",
  proposal: "Proposal",
  trigger: "Trigger",
  decision: "Decision",
  pr: "Pull request",
  commit: "Commit",
  call: "Call",
};


/**
 * Pick the right `webGet` argument for an id: a full Convex id resolves by
 * `{ id }`, a short id by `{ short_id }`. Sessions store a 7-char short id, so
 * we trim to that when the id is short. doc/project only ever carry Convex ids.
 */
export function entityQueryArgs(
  type: EntityType,
  id: string,
): { short_id?: string; id?: string; repository?: string; number?: number; sha?: string } {
  // Only a genuine 32-char Convex id may be resolved by `{ id }` (db.get). A
  // longer-than-short-id but non-Convex string (e.g. a garbled /plans/<id> URL)
  // would otherwise be sent to db.get and throw "Invalid ID length"; routing it
  // through the by_short_id index instead just resolves to null.
  if (isConvexId(id)) return { id };
  if (type === "session") return { short_id: id.slice(0, 7).toLowerCase() };
  if (type === "task" || type === "plan" || type === "trigger") return { short_id: id.toLowerCase() };
  if (type === "pr" || type === "commit") {
    // `owner/repo#482` → { repository, number }; `owner/repo@sha` → { repository, sha }.
    const ref = parseRepoObjectId(id);
    if (ref?.type === "pr") return { repository: ref.repository, number: ref.number };
    if (ref?.type === "commit") return { repository: ref.repository, sha: ref.sha };
  }
  return { id };
}


// Creator and assignee for task reference surfaces. Both are always reported
// when the row carries them — a card that hides the creator because it is the
// viewer, or the assignee because they created the task, reads as "nobody"
// to everyone else who opens it. Names resolve through the same roster helper
// the task page uses; read non-reactively — these cards mount fresh, so a
// subscription would only add churn.
export function taskPeople(task: any) {
  const s = useInboxStore.getState() as any;
  const me = s.currentUser;
  const members = s.teamMembers;
  const creatorId = task.user_id?.toString?.();
  const creator = creatorId ? resolveAssigneeInfo(creatorId, task.creator, members, me) : null;
  const assigneeId = task.assignee?.toString?.();
  const assignee = assigneeId ? resolveAssigneeInfo(assigneeId, task.assignee_info, members, me) : null;
  // One person filed the task for themselves: surfaces name them once.
  const samePerson = !!creatorId && creatorId === assigneeId;
  return { creator, assignee, samePerson };
}

// The project a task is filed under, from the local store (same non-reactive
// read as taskPeople). Null when the task is unfiled or the row is not cached.
export function taskProject(task: any): { _id: string; title: string } | null {
  const id = task.project_id?.toString?.();
  if (!id) return null;
  const row = (useInboxStore.getState() as any).projects?.[id];
  return row?.title ? { _id: id, title: row.title } : null;
}


export function abbrevModel(model?: string | null): string | null {
  if (!model) return null;
  if (model.includes("fable")) return "Fable";
  if (model.includes("opus")) return "Opus";
  if (model.includes("sonnet")) return "Sonnet";
  if (model.includes("haiku")) return "Haiku";
  return null;
}


export function relativeTime(ts?: number | null): string | null {
  if (!ts) return null;
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 5) return `${mins}m ago`;
  return "just now";
}


export type EntityResolution = {
  /** The id with any `doc:` prefix stripped — what queries and routes take. */
  rawId: string;
  /** Resolved type, or null while resolveIdType is in flight / for non-entities. */
  type: EntityType | null;
  /** The live row: server answer when it has landed, local store seed before. */
  entity: any;
  /** True once the server has answered (entity may still be null = no access). */
  served: boolean;
  status: string | undefined;
  /** What the reference is CALLED — title, else short id, else type name. */
  label: string;
  /** The same name unclipped, for surfaces with the room for it (a reveal
   *  band's strip, a hover title). */
  fullLabel: string;
  /** The object's short NAME, for a compact (repeat) mention. */
  shortLabel: string;
  /** In-app route for the object (falls back to the raw id pre-resolution). */
  href: string;
};


/** A fixed answer for a reference: what the resolver returns in place of a query. */
export type EntityFixture = { type: EntityType; entity: any };

/**
 * Fixture answers for every reference below, keyed by the id as written. When
 * set, the resolver issues no query and reads nothing from the store: a
 * listed id resolves to its fixture and any other id to "no access". The
 * homepage hero sets it so its pills never show a signed-in visitor's rows.
 */
export const EntityFixtureContext = createContext<Record<string, EntityFixture> | null>(null);

/**
 * One id in, one live entity out — the resolution every reference surface
 * shares. Local-first: seeds synchronously from the store (non-reactive read;
 * the live webGet subscription is what keeps the row fresh), so a reference to
 * a row this client already holds paints its title on the first frame.
 */
export function useEntityResolution(rawRef: string, typeProp?: EntityType): EntityResolution {
  // `id` keeps its original case (Convex ids are case-sensitive); short-id and
  // prefix matching lowercase internally.
  const trimmed = rawRef.trim();
  // A `doc:<convexId>` reference carries its type in the string itself.
  const isDocRef = !typeProp && /^doc:/i.test(trimmed);
  const rawId = isDocRef ? trimmed.slice(4) : trimmed;
  const fixtures = useContext(EntityFixtureContext);
  const fixture = fixtures ? fixtures[trimmed] ?? fixtures[rawId] ?? null : undefined;
  // Under fixtures every query below is skipped by clearing `live`.
  const live = !fixtures;
  const looksConvex = live && isConvexId(rawId);
  // A full Convex id carries no type prefix (and can even start with "jx", so
  // prefix sniffing misclassifies it) — resolve its table server-side instead.
  // Prefix detection is for short ids only.
  // No-throw: this resolver gates every other query, and a reference must
  // degrade to plain text — not crash the view — when the backend doesn't have
  // the function yet (client/deploy skew).
  // A row the store already holds names its type on the first frame.
  const storeType = useMemo(
    () => (!typeProp && !isDocRef && looksConvex ? entityTypeInStore(useInboxStore.getState(), rawId) : undefined),
    [typeProp, isDocRef, looksConvex, rawId],
  );
  const { data: resolvedType } = useQueryNoThrow(api.entities.resolveIdType, !typeProp && !isDocRef && looksConvex && !storeType ? { id: rawId } : "skip");
  const type: EntityType | null =
    fixture?.type ?? typeProp ?? (isDocRef ? "doc" : looksConvex ? storeType ?? resolvedType ?? null : entityTypeFromId(rawId));
  const isTask = type === "task";
  const isPlan = type === "plan";
  const isSession = type === "session";
  const isTrigger = type === "trigger";
  const isRepoObject = type === "pr" || type === "commit";

  const queryArgs = live && type ? entityQueryArgs(type, rawId) : null;
  const task = useQueryNoThrow(api.tasks.webGet, isTask && queryArgs ? queryArgs : "skip").data;
  const plan = useQueryNoThrow(api.plans.webGet, isPlan && queryArgs ? queryArgs : "skip").data;
  const session = useQueryNoThrow(api.conversations.webGet, isSession && queryArgs ? queryArgs : "skip").data;
  // No-throw: agentTasks.webGet is newer than some deployed clients, and a
  // conversation must not crash on a trigger reference just because the backend
  // hasn't caught up — the reference degrades to its short id, then fills in.
  const { data: trigger } = useQueryNoThrow(api.agentTasks.webGet, isTrigger && queryArgs ? queryArgs : "skip");
  // docs/projects are only ever addressed by a full Convex id.
  const doc = useQueryNoThrow(api.docs.webGet, type === "doc" && looksConvex ? { id: rawId } : "skip").data;
  const project = useQueryNoThrow(api.projects.webGet, type === "project" && looksConvex ? { id: rawId } : "skip").data;
  // An initiative is named by `in-N` or a Convex id; the store's snapshot
  // usually seeds it below, and this keeps the label live. No-throw for the
  // same client and deploy skew reason as triggers.
  const { data: initiative } = useQueryNoThrow(api.initiatives.webGet, live && type === "initiative" ? { ref: rawId } : "skip");
  // A staffing proposal (`op-N`) is store-fed: the feeder syncs
  // orgProposals.get into the orgProposals and orgProposalChanges collections
  // and the row is read back from the store, so the card's verdicts (store
  // actions) paint on the same row the reference resolves to.
  const proposalFeed = useSyncOrgProposal(live && type === "proposal" ? rawId : null);
  const proposalRow = useInboxStore((s) => (live && type === "proposal" ? findEntityInStore(s, "proposal", rawId) : undefined));
  const proposal = type === "proposal" ? (proposalFeed.ready ? proposalRow ?? null : undefined) : undefined;
  // A decision (`sd-N` or Convex id) seeds from the viewer's queue in the
  // store; the query keeps it live and covers rows the queue has dropped.
  const { data: decision } = useQueryNoThrow(api.sessionDecisions.get, live && type === "decision" ? { decision_id: rawId } : "skip");
  // A pull request or commit reference resolves by repository and number/sha,
  // or by Convex id. No-throw for the same client/deploy-skew reason as
  // triggers: a `owner/repo#482` in prose must read as text, not crash.
  const repoObjectArgs = isRepoObject && queryArgs && (queryArgs.id || queryArgs.repository) ? queryArgs : null;
  const repoObject = useRepoObject(live && isRepoObject ? type : null, rawId, repoObjectArgs);
  // A call (`cl-42`), a stretch of it (`cl-42:15-25`) or a moment of it
  // (`cl-42@12:34`): one query answers all three, the turns riding along only
  // when the reference names some, and the line said then when it names a
  // moment (the frame card's caption).
  const callRef = type === "call" ? parseCallRef(rawId) : null;
  const { data: call } = useQueryNoThrow(
    api.transcripts.webGetCallRef,
    live && callRef ? { ref: callRef.call, ...(callRef.turns ?? {}), ...(callRef.at_ms != null ? { at_ms: callRef.at_ms } : {}) } : "skip",
  );
  const served = fixtures ? fixture?.entity ?? null : isTask ? task : isPlan ? plan : isSession ? session : isTrigger ? trigger : type === "doc" ? doc : type === "project" ? project : type === "initiative" ? initiative : type === "proposal" ? proposal : type === "decision" ? decision : type === "call" ? call : undefined;

  // Local-first: the client usually already holds this row, so paint the title
  // on the FIRST frame instead of flashing the raw id until the query answers.
  // Read once and non-reactively (getState, not a subscription) — a reference
  // must not re-render on the churn of a collection with thousands of rows; the
  // live query above is what keeps the label fresh.
  const seed = useMemo(
    () => (live && type ? findEntityInStore(useInboxStore.getState(), type, rawId) : undefined),
    [live, type, rawId],
  );
  const entity: any = fixtures ? served : isRepoObject ? repoObject.entity ?? seed : served ?? seed;

  // One label rule for every type, shared with mobile: the reference reads as
  // the object's NAME, and the id moves to the detail surfaces. A trigger
  // prefers its display_title — the generated short name, not the whole
  // prompt's first line.
  const resolvedTitle: string | undefined =
    (isTrigger ? entity?.display_title : undefined) || (type === "decision" ? entity?.question : undefined) || (isRepoObject && type ? repoObjectTitle(type, entity) : undefined) || entity?.title || entity?.display_title || entity?.name;
  const labelArgs = {
    title: resolvedTitle,
    shortId: entity?.short_id,
    rawId,
    typeLabel: type ? TYPE_LABEL[type] : null,
  };
  // A stretch of a call reads as the call plus the transcript lines it names,
  // and a moment of it as the call plus the time on the player.
  const turnsSuffix = callRefLabelSuffix(callRef);
  const label = entityReferenceLabel(labelArgs) + turnsSuffix;
  const fullLabel = resolvedTitle?.trim() ? resolvedTitle.trim() + turnsSuffix : label;
  // Sessions carry a generated short name (title generation writes
  // `short_title`); everything else derives one from its title.
  const shortLabel = entityShortLabel({ ...labelArgs, shortTitle: entity?.short_title }) + turnsSuffix;

  // Route that opens this entity. Prefer the resolved Convex id; fall back to
  // the raw id so the link still works in the brief window before the query
  // resolves.
  // A repository object routes by its repository and number/sha, never by
  // Convex id (no such page), so the resolved row supplies the reference when
  // the raw id was a Convex id. The commit page matches the sha exactly, so
  // the route carries the full one.
  // An initiative's page is addressed by its `in-N`, a proposal's by its
  // `op-N` and a decision's by its `sd-N`: the form a person reads.
  const routeId = isRepoObject && type ? repoObjectRefOf(type, entity, 40) ?? rawId : callRef ? callRefId(entity?._id ?? callRef.call, callRef.turns, callRef.at_ms) : ((type === "initiative" || type === "proposal" || type === "decision") && entity?.short_id) || (entity?._id ?? rawId);
  const href = entityRoute(type ?? "session", routeId) ?? "#";

  return { rawId, type, entity, served: fixtures ? true : isRepoObject ? repoObject.ready : served !== undefined, status: entity?.status, label, fullLabel, shortLabel, href };
}
