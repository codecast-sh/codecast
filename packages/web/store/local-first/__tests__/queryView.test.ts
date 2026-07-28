import { describe, expect, test } from "bun:test";
import { defineQueryView } from "../queryView";

type Envelope =
  | { contractId: "things.principal/v2"; viewKey: string; access: "unauthenticated" }
  | {
      contractId: "things.principal/v2";
      viewKey: string;
      access: "forbidden";
      revokedGrantKeys: readonly string[];
    }
  | {
      contractId: "things.principal/v2";
      viewKey: string;
      access: "granted";
      grantKeys: readonly string[];
      viewRevision: number;
      coverage?: { kind: "view-revision"; revision: string; revisionOrder: number };
      things: readonly { _id: string; name: string }[];
    };

const queryRef = {} as never;

const thingsView = defineQueryView({
  id: "things.principal/v2",
  query: queryRef,
  key: ({ scope }: { scope: string }) => `things:${scope}`,
  queryArgs: ({ scope }) => ({ scope_name: scope }) as never,
  rows: (granted: Extract<Envelope, { access: "granted" }>) => granted.things,
  entityKey: (row) => `thing:${row._id}`,
});

describe("defineQueryView", () => {
  test("granted standard envelopes decode without per-view code", () => {
    const decoded = thingsView.decode({
      contractId: "things.principal/v2",
      viewKey: "things:home",
      access: "granted",
      grantKeys: ["grant-a"],
      viewRevision: 4,
      coverage: { kind: "view-revision", revision: "4", revisionOrder: 4 },
      things: [{ _id: "t1", name: "one" }],
    } satisfies Envelope as never);
    expect(decoded).toEqual({
      contractId: "things.principal/v2",
      viewKey: "things:home",
      access: "granted",
      grantKeys: ["grant-a"],
      coverage: { kind: "view-revision", revision: "4", revisionOrder: 4 },
      rows: [{ _id: "t1", name: "one" }],
    });
  });

  test("a server without envelope coverage still proves its view revision", () => {
    const decoded = thingsView.decode({
      contractId: "things.principal/v2",
      viewKey: "things:home",
      access: "granted",
      grantKeys: ["grant-a"],
      viewRevision: 7,
      things: [],
    } satisfies Envelope as never);
    expect(decoded).toMatchObject({
      access: "granted",
      coverage: { kind: "view-revision", revision: "7", revisionOrder: 7 },
    });
  });

  test("non-granted envelopes pass through untouched", () => {
    const forbidden: Envelope = {
      contractId: "things.principal/v2",
      viewKey: "things:home",
      access: "forbidden",
      revokedGrantKeys: ["grant-a"],
    };
    expect(thingsView.decode(forbidden as never)).toEqual(forbidden);
  });

  test("normalize defaults to identity projection under the declared entity key", () => {
    const normalized = thingsView.normalize(
      { _id: "t1", name: "one" },
      { args: { scope: "home" }, grantKeys: ["grant-a"] },
    );
    expect(normalized).toEqual({
      entityKey: "thing:t1",
      grantKeys: ["grant-a"],
      projection: { _id: "t1", name: "one" },
    });
  });

  test("queryArgs maps contract args; identity when omitted", () => {
    expect(thingsView.queryArgs({ scope: "home" })).toEqual({ scope_name: "home" } as never);
    const identityView = defineQueryView({
      id: "things.principal/v2",
      query: queryRef,
      key: ({ scope }: { scope: string }) => `things:${scope}`,
      rows: (granted: Extract<Envelope, { access: "granted" }>) => granted.things,
      entityKey: (row) => `thing:${row._id}`,
    });
    expect(identityView.queryArgs({ scope: "home" })).toEqual({ scope: "home" } as never);
  });
});
