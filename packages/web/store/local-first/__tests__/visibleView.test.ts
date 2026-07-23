import { describe, expect, test } from "bun:test";
import type {
  CommandRecord,
  PrincipalStoreSnapshot,
} from "../persistence/adapter";
import {
  asCommitSequence,
  asGrantKey,
  asPrincipalId,
  asSourceEpoch,
  asSourceSequence,
  asWriterEpoch,
} from "../types";
import { selectVisibleMaterializedView } from "../visibleView";

const VIEW = "comments:conversation:one";

function snapshot(commands: CommandRecord[] = []): PrincipalStoreSnapshot {
  return {
    metadata: {
      key: "store",
      schemaVersion: 3,
      principalKey: "opaque" as any,
      principalId: asPrincipalId("principal"),
      activeGeneration: 1,
      fenced: false,
      head: asCommitSequence(3),
      createdAt: 1,
      updatedAt: 2,
    },
    entities: [],
    entityTombstones: [],
    views: [{
      key: VIEW,
      contractId: "comments.byConversation/v2",
      grantKeys: [asGrantKey("conversation-one")],
      revision: 3,
      writerEpoch: asWriterEpoch(1),
      sourceEpoch: asSourceEpoch("source"),
      sourceSequence: asSourceSequence(1),
      coverage: { kind: "view-revision", revision: "3", revisionOrder: 3 },
    }],
    viewWriters: [],
    viewSegments: [],
    viewMembers: [{
      key: `${VIEW}\0complete\0comment:server`,
      viewKey: VIEW,
      entityKey: "comment:server",
      segmentKey: "complete",
      grantKeys: [asGrantKey("conversation-one")],
    }],
    viewProjections: [{
      key: `${VIEW}\0complete\0comment:server`,
      viewKey: VIEW,
      entityKey: "comment:server",
      segmentKey: "complete",
      value: { _id: "server", content: "base" },
    }],
    grants: [],
    commands,
    commandReceipts: [],
    syncMetadata: [],
    deltaCursors: [],
  };
}

function command(input: Partial<CommandRecord> & Pick<CommandRecord, "id" | "localSequence">): CommandRecord {
  return {
    id: input.id,
    principalId: asPrincipalId("principal"),
    contractId: "comments.command/v2",
    commandType: "comments.update/v2",
    conflictKey: "comment:server",
    status: "queued",
    createdAt: input.localSequence,
    localSequence: input.localSequence,
    operationSchemaVersion: 1,
    targetGrantKeys: [asGrantKey("conversation-one")],
    targetEntityKeys: ["comment:server"],
    optimisticActive: true,
    replayPolicy: "server-deduplicated",
    payload: {},
    requiredCoverage: {
      kind: "view-revision",
      contractId: "comments.byConversation/v2",
      viewKey: VIEW,
    },
    optimisticOperations: [],
    ...input,
  };
}

describe("visible materialized view", () => {
  test("folds durable optimistic operations in command order", () => {
    const result = selectVisibleMaterializedView(snapshot([
      command({
        id: "first",
        localSequence: 4,
        optimisticOperations: [{
          kind: "set-entity-field",
          entityKey: "comment:server",
          field: "content",
          value: "first edit",
        }],
      }),
      command({
        id: "second",
        localSequence: 5,
        optimisticOperations: [{
          kind: "set-entity-field",
          entityKey: "comment:server",
          field: "content",
          value: "second edit",
        }],
      }),
      command({
        id: "create",
        localSequence: 6,
        optimisticOperations: [{
          kind: "upsert-projection",
          viewKey: VIEW,
          entityKey: "comment:local",
          value: { _id: "local", content: "new" },
        }],
      }),
    ]), VIEW);
    expect(result.rows).toEqual([
      { entityKey: "comment:local", value: { _id: "local", content: "new" } },
      { entityKey: "comment:server", value: { _id: "server", content: "second edit" } },
    ]);
    expect(result.activeCommandIds).toEqual(["first", "second", "create"]);
  });

  test("terminal commands reveal current authority without inverse patches", () => {
    const rejected = command({
      id: "rejected",
      localSequence: 4,
      status: "rejected",
      optimisticActive: false,
      optimisticOperations: [{
        kind: "set-entity-field",
        entityKey: "comment:server",
        field: "content",
        value: "rejected edit",
      }],
    });
    expect(selectVisibleMaterializedView(snapshot([rejected]), VIEW).rows).toEqual([
      { entityKey: "comment:server", value: { _id: "server", content: "base" } },
    ]);
  });

  test("hide and later upsert compose without resurrecting stale base", () => {
    const result = selectVisibleMaterializedView(snapshot([
      command({
        id: "hide",
        localSequence: 4,
        optimisticOperations: [{ kind: "hide-entity", entityKey: "comment:server" }],
      }),
      command({
        id: "later",
        localSequence: 5,
        optimisticOperations: [{
          kind: "upsert-projection",
          viewKey: VIEW,
          entityKey: "comment:server",
          value: { _id: "server", content: "replacement" },
        }],
      }),
    ]), VIEW);
    expect(result.rows).toEqual([
      { entityKey: "comment:server", value: { _id: "server", content: "replacement" } },
    ]);
  });
});
