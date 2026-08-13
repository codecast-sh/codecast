import { describe, expect, it } from "bun:test";
import { SCOPE_KINDS, type CapabilityBinding, type ScopeKind } from "./capabilities";
import {
  desiredCapabilities,
  desiredCapabilitySlugs,
  explainCapability,
  findResolved,
  resolveCapabilities,
  type ScopeContext,
} from "./capabilityResolver";
import {
  GOLDEN_CASES,
  projectDesiredState,
} from "./__fixtures__/capabilityResolverGolden";

const USER = "user_ashot";
const TEAM = "team_codecast";
const DEVICE = "device_m1";
const PROJECT = "git:github.com/ashot/codecast";
const SESSION = "conv_jx7c6zk";
const SLUG = "builtin/memory";

/** A context standing in every scope at once, so any pair can be exercised. */
const FULL: ScopeContext = {
  userId: USER,
  teamIds: [TEAM],
  deviceId: DEVICE,
  projectKeys: [PROJECT],
  conversationId: SESSION,
  client: "claude",
};

const SCOPE_KEY: Record<ScopeKind, string> = {
  team: TEAM,
  user: USER,
  device: DEVICE,
  project: PROJECT,
  session: SESSION,
};

function bind(
  id: string,
  scopeKind: ScopeKind,
  enabled: boolean,
  over: Partial<CapabilityBinding> = {},
): CapabilityBinding {
  return {
    id,
    userId: USER,
    capabilitySlug: SLUG,
    scopeKind,
    scopeKey: SCOPE_KEY[scopeKind],
    enabled,
    updatedAt: 1_000,
    ...(scopeKind === "team" ? { teamId: TEAM } : {}),
    ...over,
  };
}

describe("resolveCapabilities — the precedence table", () => {
  const narrower: Record<ScopeKind, ScopeKind[]> = {
    team: [],
    user: ["team"],
    device: ["team", "user"],
    project: ["team", "user", "device"],
    session: ["team", "user", "device", "project"],
  };

  // Every ordered pair of distinct scopes, in both flag directions. This is the
  // table the whole feature rests on, so it is generated rather than sampled.
  for (const narrow of SCOPE_KINDS) {
    for (const wide of narrower[narrow]) {
      it(`${narrow} disable beats ${wide} enable`, () => {
        const state = resolveCapabilities(
          [bind("b_wide", wide, true), bind("b_narrow", narrow, false)],
          FULL,
        );
        const entry = findResolved(state, SLUG)!;
        expect(entry.enabled).toBe(false);
        expect(entry.decidedBy.bindingId).toBe("b_narrow");
        expect(entry.decidedBy.scopeKind).toBe(narrow);
        expect(entry.overrode.map((o) => o.bindingId)).toEqual(["b_wide"]);
        expect(desiredCapabilitySlugs(state)).toEqual([]);
      });

      it(`${narrow} enable beats ${wide} disable`, () => {
        const state = resolveCapabilities(
          [bind("b_wide", wide, false), bind("b_narrow", narrow, true)],
          FULL,
        );
        const entry = findResolved(state, SLUG)!;
        expect(entry.enabled).toBe(true);
        expect(entry.decidedBy.bindingId).toBe("b_narrow");
        expect(desiredCapabilitySlugs(state)).toEqual([SLUG]);
      });
    }
  }

  it("input order never changes the answer", () => {
    const rows = [
      bind("b_team", "team", true),
      bind("b_user", "user", false),
      bind("b_device", "device", true),
      bind("b_project", "project", false),
      bind("b_session", "session", true),
    ];
    const forward = projectDesiredState(resolveCapabilities(rows, FULL));
    const backward = projectDesiredState(resolveCapabilities([...rows].reverse(), FULL));
    expect(backward).toEqual(forward);
    expect(forward.entries[SLUG]).toBe("on@session:b_session");
  });

  it("lists everything the winner outranked, narrowest first", () => {
    const state = resolveCapabilities(
      [
        bind("b_team", "team", true),
        bind("b_user", "user", false),
        bind("b_device", "device", true),
        bind("b_project", "project", false),
      ],
      FULL,
    );
    const entry = findResolved(state, SLUG)!;
    expect(entry.decidedBy.scopeKind).toBe("project");
    expect(entry.overrode.map((o) => o.scopeKind)).toEqual(["device", "user", "team"]);
    // The trace carries the flag too — "your team turned this on, your device
    // turned it off" is the sentence the card renders.
    expect(entry.overrode.map((o) => o.enabled)).toEqual([true, false, true]);
  });
});

describe("resolveCapabilities — ordering inside one scope", () => {
  it("the later write wins", () => {
    const state = resolveCapabilities(
      [
        bind("b_old", "user", true, { updatedAt: 10 }),
        bind("b_new", "user", false, { updatedAt: 20 }),
      ],
      FULL,
    );
    expect(findResolved(state, SLUG)!.decidedBy.bindingId).toBe("b_new");
  });

  it("the row id breaks an identical timestamp, so there is no tie", () => {
    const a = resolveCapabilities(
      [bind("b_zzz", "user", true, { updatedAt: 5 }), bind("b_aaa", "user", false, { updatedAt: 5 })],
      FULL,
    );
    const b = resolveCapabilities(
      [bind("b_aaa", "user", false, { updatedAt: 5 }), bind("b_zzz", "user", true, { updatedAt: 5 })],
      FULL,
    );
    expect(findResolved(a, SLUG)!.decidedBy.bindingId).toBe("b_aaa");
    expect(findResolved(b, SLUG)!.decidedBy.bindingId).toBe("b_aaa");
  });

  it("a non-finite timestamp sorts oldest instead of poisoning the order", () => {
    // Every comparison against NaN is false, so an unguarded subtraction makes
    // the winner depend on the engine's sort internals — and two runtimes then
    // disagree about the same rows.
    const state = resolveCapabilities(
      [
        bind("b_nan", "user", true, { updatedAt: Number.NaN }),
        bind("b_real", "user", false, { updatedAt: 1 }),
      ],
      FULL,
    );
    expect(findResolved(state, SLUG)!.decidedBy.bindingId).toBe("b_real");
    expect(findResolved(state, SLUG)!.overrode[0]!.updatedAt).toBe(0);
  });

  it("two bindings at the same scope for different keys still order deterministically", () => {
    const twoTeams: ScopeContext = { ...FULL, teamIds: [TEAM, "team_other"] };
    const state = resolveCapabilities(
      [
        bind("b_t1", "team", true, { updatedAt: 5 }),
        bind("b_t2", "team", false, { scopeKey: "team_other", teamId: "team_other", updatedAt: 9 }),
      ],
      twoTeams,
    );
    expect(findResolved(state, SLUG)!.decidedBy.bindingId).toBe("b_t2");
    expect(findResolved(state, SLUG)!.enabled).toBe(false);
  });
});

describe("resolveCapabilities — scope applicability", () => {
  it("returns nothing for no bindings", () => {
    const state = resolveCapabilities([], FULL);
    expect(state.entries).toEqual([]);
    expect(state.ignored).toEqual([]);
    expect(desiredCapabilities(state)).toEqual([]);
  });

  it("sets aside a binding for every other scope instance, with a reason", () => {
    const elsewhere: Array<[string, CapabilityBinding]> = [
      ["another team", bind("b_team", "team", true, { scopeKey: "team_x", teamId: "team_x" })],
      ["another user", bind("b_user", "user", true, { scopeKey: "user_x", userId: "user_x" })],
      ["another device", bind("b_device", "device", true, { scopeKey: "device_x" })],
      ["another project", bind("b_project", "project", true, { scopeKey: "git:elsewhere" })],
      ["another session", bind("b_session", "session", true, { scopeKey: "conv_x" })],
    ];
    for (const [detail, row] of elsewhere) {
      const state = resolveCapabilities([row], FULL);
      expect(state.entries).toEqual([]);
      expect(state.ignored).toHaveLength(1);
      expect(state.ignored[0]!.reason).toBe("scope_not_in_context");
      expect(state.ignored[0]!.detail).toBe(detail);
    }
  });

  it("names the missing axis when the context does not stand anywhere", () => {
    const bare: ScopeContext = { userId: USER };
    const state = resolveCapabilities(
      [
        bind("b_device", "device", true),
        bind("b_project", "project", true),
        bind("b_session", "session", true),
        bind("b_team", "team", true),
      ],
      bare,
    );
    expect(state.entries).toEqual([]);
    const reasons = Object.fromEntries(state.ignored.map((i) => [i.bindingId, i.detail]));
    expect(reasons).toEqual({
      b_device: "no device in this context",
      b_project: "no project in this context",
      b_session: "no session in this context",
      b_team: "not in any team here",
    });
  });

  it("matches a project by any of its keys", () => {
    const ctx: ScopeContext = { ...FULL, projectKeys: [PROJECT, `local:${USER}:/Users/ashot/src/codecast`] };
    const state = resolveCapabilities(
      [bind("b_local", "project", true, { scopeKey: `local:${USER}:/Users/ashot/src/codecast` })],
      ctx,
    );
    expect(findResolved(state, SLUG)!.enabled).toBe(true);
  });

  it("treats a blank user scope key as the row's owner", () => {
    // Older writers left it blank because `user_id` already said whose it was.
    const state = resolveCapabilities([bind("b_blank", "user", true, { scopeKey: "" })], FULL);
    expect(findResolved(state, SLUG)!.decidedBy.scopeKey).toBe(USER);
  });

  it("still refuses a blank key at every other scope", () => {
    for (const scope of ["team", "device", "project", "session"] as ScopeKind[]) {
      const state = resolveCapabilities([bind("b_blank", scope, true, { scopeKey: "  " })], FULL);
      expect(state.ignored[0]!.reason).toBe("malformed_binding");
      expect(state.ignored[0]!.detail).toBe(`no scope key for ${scope} scope`);
    }
  });
});

describe("resolveCapabilities — client filter", () => {
  it("sets aside a binding bound to other clients", () => {
    const state = resolveCapabilities([bind("b_codex", "user", true, { clientFilter: ["codex"] })], FULL);
    expect(state.entries).toEqual([]);
    expect(state.ignored[0]).toMatchObject({ reason: "client_filtered", detail: "bound to codex" });
  });

  it("applies a binding that names this client", () => {
    const state = resolveCapabilities(
      [bind("b_claude", "user", true, { clientFilter: ["claude", "codex"] })],
      FULL,
    );
    expect(findResolved(state, SLUG)!.enabled).toBe(true);
  });

  it("ignores the filter when no client was named — that view is the union", () => {
    const noClient: ScopeContext = { ...FULL, client: undefined };
    const state = resolveCapabilities([bind("b_codex", "user", true, { clientFilter: ["codex"] })], noClient);
    expect(findResolved(state, SLUG)!.enabled).toBe(true);
  });

  it("an empty filter means every client", () => {
    const state = resolveCapabilities([bind("b_any", "user", true, { clientFilter: [] })], FULL);
    expect(findResolved(state, SLUG)!.enabled).toBe(true);
  });
});

describe("resolveCapabilities — config trust", () => {
  it("carries the owner's own config at user and device scope", () => {
    for (const scope of ["user", "device"] as ScopeKind[]) {
      const state = resolveCapabilities([bind("b", scope, true, { config: { REGION: "eu" } })], FULL);
      expect(findResolved(state, SLUG)!.config).toEqual({ REGION: "eu" });
      expect(findResolved(state, SLUG)!.withheld).toBeUndefined();
    }
  });

  it("withholds a config that arrived from a scope a repo or a teammate controls", () => {
    const cases: Array<[ScopeKind, Partial<CapabilityBinding>]> = [
      ["project", {}],
      ["session", {}],
      ["team", { userId: "user_sam" }],
      ["user", { userId: "user_sam", scopeKey: USER }],
    ];
    for (const [scope, over] of cases) {
      const state = resolveCapabilities(
        [bind("b", scope, true, { config: { CMD: "npx -y @evil/thing" }, ...over })],
        FULL,
      );
      const entry = findResolved(state, SLUG)!;
      expect(entry.withheld).toBe("config_scope_not_trusted");
      expect(entry.config).toBeUndefined();
      // Withheld is not the same as off: the wish still resolved to enabled,
      // and the card has to say why nothing landed.
      expect(entry.enabled).toBe(true);
      expect(desiredCapabilities(state)).toEqual([]);
    }
  });

  it("an empty config object is not a config", () => {
    const state = resolveCapabilities([bind("b", "project", true, { config: {} })], FULL);
    expect(findResolved(state, SLUG)!.withheld).toBeUndefined();
    expect(desiredCapabilitySlugs(state)).toEqual([SLUG]);
  });

  it("a config that is not a plain object is not a config", () => {
    // A string would pass a bare key-count test and then spread into
    // `{0: "n", 1: "p", …}` — a config nobody wrote, reaching a driver.
    for (const junk of ["npx", ["npx"], null]) {
      const state = resolveCapabilities([bind("b", "user", true, { config: junk as never })], FULL);
      expect(findResolved(state, SLUG)!.config).toBeUndefined();
      expect(findResolved(state, SLUG)!.withheld).toBeUndefined();
    }
  });

  it("copies the config rather than aliasing the binding", () => {
    const row = bind("b", "user", true, { config: { REGION: "eu" } });
    const entry = findResolved(resolveCapabilities([row], FULL), SLUG)!;
    entry.config!.REGION = "us";
    expect(row.config!.REGION).toBe("eu");
  });

  it("does not withhold a config on a binding that resolved to off", () => {
    const state = resolveCapabilities([bind("b", "team", false, { config: { A: "1" }, userId: "user_sam" })], FULL);
    expect(findResolved(state, SLUG)!.withheld).toBeUndefined();
    expect(findResolved(state, SLUG)!.enabled).toBe(false);
  });
});

describe("resolveCapabilities — bad rows", () => {
  it("drops each malformed shape with the field that failed, and keeps going", () => {
    const good = bind("b_good", "user", true, { capabilitySlug: "builtin/tasks" });
    const bad: Array<[CapabilityBinding, string]> = [
      [{ ...bind("b1", "user", true), id: "" }, "no binding id"],
      [{ ...bind("b2", "user", true), capabilitySlug: "   " }, "no capability slug"],
      [{ ...bind("b3", "user", true), enabled: "yes" as never }, "enabled is not a boolean"],
      [{ ...bind("b4", "user", true), scopeKind: "org" as never }, 'unknown scope "org"'],
      [{ ...bind("b5", "user", true), userId: "" }, "no owner"],
      [{ ...bind("b6", "user", true), scopeKey: 42 as never }, "scope key is not a string"],
    ];
    for (const [row, detail] of bad) {
      const state = resolveCapabilities([row, good], FULL);
      expect(desiredCapabilitySlugs(state)).toEqual(["builtin/tasks"]);
      const dropped = state.ignored.find((i) => i.reason === "malformed_binding");
      expect(dropped?.detail).toBe(detail);
    }
  });

  it("survives a non-array and null rows without throwing", () => {
    expect(resolveCapabilities(undefined as never, FULL).entries).toEqual([]);
    const state = resolveCapabilities([null as never, bind("b", "user", true)], FULL);
    expect(desiredCapabilitySlugs(state)).toEqual([SLUG]);
    expect(state.ignored[0]!.reason).toBe("malformed_binding");
  });
});

describe("resolveCapabilities — reading the result", () => {
  it("sorts entries by slug and ignored rows deterministically", () => {
    const state = resolveCapabilities(
      [
        bind("b_z", "user", true, { capabilitySlug: "mkt/acme/z" }),
        bind("b_a", "user", true, { capabilitySlug: "builtin/a" }),
        bind("b_m", "user", true, { capabilitySlug: "git/x/m@sha" }),
      ],
      FULL,
    );
    expect(state.entries.map((e) => e.slug)).toEqual(["builtin/a", "git/x/m@sha", "mkt/acme/z"]);
  });

  it("explains one capability from both sides", () => {
    const state = resolveCapabilities(
      [
        bind("b_user", "user", true),
        bind("b_other_device", "device", false, { scopeKey: "device_x" }),
        bind("b_unrelated", "user", true, { capabilitySlug: "builtin/tasks" }),
      ],
      FULL,
    );
    const why = explainCapability(state, SLUG);
    expect(why.resolved?.decidedBy.bindingId).toBe("b_user");
    expect(why.ignored.map((i) => i.bindingId)).toEqual(["b_other_device"]);
  });

  it("separates the desired set from the resolved set", () => {
    const state = resolveCapabilities(
      [
        bind("b_on", "user", true),
        bind("b_off", "user", true, { capabilitySlug: "builtin/tasks" }),
        bind("b_off2", "device", false, { capabilitySlug: "builtin/tasks" }),
      ],
      FULL,
    );
    expect(state.entries).toHaveLength(2);
    expect(desiredCapabilitySlugs(state)).toEqual([SLUG]);
  });
});

describe("golden precedence table", () => {
  for (const c of GOLDEN_CASES) {
    it(c.name, () => {
      const projected = projectDesiredState(resolveCapabilities(c.bindings, c.context));
      expect(projected.entries).toEqual(c.entries);
      expect(projected.ignored).toEqual(c.ignored);
    });
  }
});
