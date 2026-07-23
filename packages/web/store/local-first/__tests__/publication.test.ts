import { describe, expect, test } from "bun:test";
import type { PrincipalStoreSnapshot } from "../persistence/adapter";
import { MaterializedPublicationRegistry } from "../publication";
import {
  asCommitSequence,
  asPrincipalId,
  asSourceEpoch,
  asSourceSequence,
  asWriterEpoch,
} from "../types";

function snapshot(): PrincipalStoreSnapshot {
  return {
    metadata: {
      key: "store",
      schemaVersion: 3,
      principalKey: "opaque" as any,
      principalId: asPrincipalId("principal"),
      activeGeneration: 1,
      fenced: false,
      head: asCommitSequence(8),
      createdAt: 1,
      updatedAt: 2,
    },
    entities: [],
    entityTombstones: [],
    views: [{
      key: "things:one",
      contractId: "things/v2",
      grantKeys: [],
      revision: 2,
      writerEpoch: asWriterEpoch(1),
      sourceEpoch: asSourceEpoch("source"),
      sourceSequence: asSourceSequence(1),
      coverage: { kind: "view-revision", revision: "2", revisionOrder: 2 },
    }],
    viewWriters: [{ key: "things:one", contractId: "things/v2", writerEpoch: asWriterEpoch(1), lastAccess: "granted" }],
    viewSegments: [],
    viewMembers: [{ key: "member", viewKey: "things:one", entityKey: "thing:a", segmentKey: "complete", grantKeys: [] }],
    viewProjections: [{ key: "projection", viewKey: "things:one", entityKey: "thing:a", segmentKey: "complete", value: { _id: "a" } }],
    grants: [],
    commands: [],
    commandReceipts: [],
    syncMetadata: [],
    deltaCursors: [],
  };
}

describe("materialized publication registry", () => {
  test("publishes only through the registered contract boundary", () => {
    const seen: unknown[] = [];
    const registry = new MaterializedPublicationRegistry();
    registry.register({
      contractId: "things/v2",
      matches: (key) => key.startsWith("things:"),
      publish: (value) => seen.push(value),
    });
    expect(registry.publish(snapshot(), "things/v2", "things:one")).toBe(true);
    expect(seen).toEqual([expect.objectContaining({
      contractId: "things/v2",
      viewKey: "things:one",
      access: "granted",
      head: 8,
      rows: [{ entityKey: "thing:a", value: { _id: "a" } }],
    })]);
    expect(registry.publish(snapshot(), "unknown/v2", "things:one")).toBe(false);
  });

  test("publishes an explicit forbidden empty view from its durable writer head", () => {
    const input = snapshot();
    input.views = [];
    input.viewMembers = [];
    input.viewProjections = [];
    input.viewWriters = [{
      key: "things:one",
      contractId: "things/v2",
      writerEpoch: asWriterEpoch(2),
      lastAccess: "forbidden",
    }];
    let seen: any;
    const registry = new MaterializedPublicationRegistry();
    registry.register({ contractId: "things/v2", matches: () => true, publish: (value) => { seen = value; } });
    expect(registry.publishKnownViews(input)).toEqual(["things:one"]);
    expect(seen).toMatchObject({ access: "forbidden", rows: [] });
  });

  test("rejects duplicate publishers so ownership cannot be ambiguous", () => {
    const registry = new MaterializedPublicationRegistry();
    registry.register({ contractId: "things/v2", matches: () => true, publish: () => {} });
    expect(() => registry.register({
      contractId: "things/v2",
      matches: () => true,
      publish: () => {},
    })).toThrow("already registered");
  });

  test("refuses to publish a view through another contract's sink", () => {
    const registry = new MaterializedPublicationRegistry();
    registry.register({ contractId: "other/v2", matches: () => true, publish: () => {} });
    expect(() => registry.publish(snapshot(), "other/v2", "things:one"))
      .toThrow("Durable view identity does not match publisher");
  });
});
