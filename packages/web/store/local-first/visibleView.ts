import { activeOptimisticOperations } from "./commands";
import type {
  CommandRecord,
  PrincipalStoreSnapshot,
  ViewRecord,
} from "./persistence/adapter";

export type VisibleViewRow = {
  entityKey: string;
  value: unknown;
};

export type VisibleMaterializedView = {
  view: ViewRecord | null;
  rows: readonly VisibleViewRow[];
  activeCommandIds: readonly string[];
};

function activeCommandsForView(
  commands: readonly CommandRecord[],
  viewKey: string,
): CommandRecord[] {
  return commands.filter((command) =>
    command.optimisticActive && command.optimisticOperations.some((operation) =>
      operation.kind === "set-entity-field" || operation.kind === "hide-entity"
        ? command.targetEntityKeys.includes(operation.entityKey)
        : operation.viewKey === viewKey,
    ));
}

/**
 * The single visible-state fold used by UI publication and shadow validation.
 * Authoritative durable rows are the base; ordered durable command operations
 * are the overlay. Removing a rejected/reconciled command therefore reveals
 * the newest base instead of applying a stale inverse patch.
 */
export function selectVisibleMaterializedView(
  snapshot: PrincipalStoreSnapshot,
  viewKey: string,
): VisibleMaterializedView {
  const view = snapshot.views.find((candidate) => candidate.key === viewKey) ?? null;
  const members = snapshot.viewMembers
    .filter((member) => member.viewKey === viewKey)
    .sort((left, right) => left.entityKey.localeCompare(right.entityKey));
  const projectionByEntity = new Map(
    snapshot.viewProjections
      .filter((projection) => projection.viewKey === viewKey)
      .map((projection) => [projection.entityKey, projection.value]),
  );
  const entityByKey = new Map(snapshot.entities.map((entity) => [entity.key, entity.value]));
  const visible = new Map<string, unknown>();
  for (const member of members) {
    if (projectionByEntity.has(member.entityKey)) {
      visible.set(member.entityKey, projectionByEntity.get(member.entityKey));
    } else if (entityByKey.has(member.entityKey)) {
      visible.set(member.entityKey, entityByKey.get(member.entityKey));
    }
  }

  const commands = activeCommandsForView(snapshot.commands, viewKey);
  for (const operation of activeOptimisticOperations(commands)) {
    switch (operation.kind) {
      case "upsert-projection":
        if (operation.viewKey === viewKey) visible.set(operation.entityKey, operation.value);
        break;
      case "remove-projection":
        if (operation.viewKey === viewKey) visible.delete(operation.entityKey);
        break;
      case "set-entity-field": {
        if (!visible.has(operation.entityKey)) break;
        const current = visible.get(operation.entityKey);
        if (!current || typeof current !== "object" || Array.isArray(current)) {
          throw new TypeError(`Cannot set ${operation.field} on non-record ${operation.entityKey}`);
        }
        visible.set(operation.entityKey, {
          ...(current as Record<string, unknown>),
          [operation.field]: operation.value,
        });
        break;
      }
      case "hide-entity":
        visible.delete(operation.entityKey);
        break;
    }
  }

  return {
    view,
    rows: [...visible.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([entityKey, value]) => ({ entityKey, value })),
    activeCommandIds: commands
      .sort((left, right) => left.localSequence - right.localSequence || left.id.localeCompare(right.id))
      .map((command) => command.id),
  };
}
