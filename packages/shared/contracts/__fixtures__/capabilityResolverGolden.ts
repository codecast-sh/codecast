// The golden precedence table: input rows, the context they resolve against,
// and the answer, written out by hand.
//
// It lives beside the contract rather than inside a test file because three
// runtimes have to agree on it. The CLI and Convex can import these cases and
// assert their own call sites produce the same projection, which is how a
// drift between the daemon's answer and the browser's answer gets caught by a
// test instead of by a person saying "the toggle did not take on my laptop".
//
// The projection is deliberately compact. Pinning whole `DesiredState` objects
// would make every case unreadable and would fail on any additive field, so a
// case pins the two things that decide behaviour: what the machine ends up
// with, and which binding decided it.

import type { CapabilityBinding, DesiredState } from "../capabilities";
import type { ScopeContext } from "../capabilityResolver";

export interface GoldenCase {
  name: string;
  bindings: CapabilityBinding[];
  context: ScopeContext;
  /** `slug` → `"<state>@<scopeKind>:<bindingId>"`, sorted by slug. */
  entries: Record<string, string>;
  /** `bindingId` → `"<reason>"`, for rows that never entered the contest. */
  ignored: Record<string, string>;
}

/** The compact form a case pins. Exported so other packages assert against the
 *  same projection instead of inventing a second one. */
export function projectDesiredState(state: DesiredState): {
  entries: Record<string, string>;
  ignored: Record<string, string>;
} {
  const entries: Record<string, string> = {};
  for (const e of state.entries) {
    const status = e.withheld ? `withheld:${e.withheld}` : e.enabled ? "on" : "off";
    entries[e.slug] = `${status}@${e.decidedBy.scopeKind}:${e.decidedBy.bindingId}`;
  }
  const ignored: Record<string, string> = {};
  for (const i of state.ignored) ignored[i.bindingId] = i.reason;
  return { entries, ignored };
}

const USER = "user_ashot";
const TEAM = "team_codecast";
const DEVICE = "device_m1";
const PROJECT = "git:github.com/ashot/codecast";
const SESSION = "conv_jx7c6zk";

/** A context standing in every scope at once, so a case can exercise any pair. */
export const GOLDEN_CONTEXT: ScopeContext = {
  userId: USER,
  teamIds: [TEAM],
  deviceId: DEVICE,
  projectKeys: [PROJECT],
  conversationId: SESSION,
  client: "claude",
};

function binding(over: Partial<CapabilityBinding> & Pick<CapabilityBinding, "id" | "scopeKind">): CapabilityBinding {
  const scopeKeys = {
    team: TEAM,
    user: USER,
    device: DEVICE,
    project: PROJECT,
    session: SESSION,
  } as const;
  return {
    userId: USER,
    capabilitySlug: "builtin/memory",
    scopeKey: scopeKeys[over.scopeKind],
    enabled: true,
    updatedAt: 1_000,
    ...over,
  };
}

export const GOLDEN_CASES: GoldenCase[] = [
  {
    name: "nothing bound resolves to nothing",
    bindings: [],
    context: GOLDEN_CONTEXT,
    entries: {},
    ignored: {},
  },
  {
    name: "a team offer with no narrower answer stands",
    bindings: [binding({ id: "b_team", scopeKind: "team", teamId: TEAM })],
    context: GOLDEN_CONTEXT,
    entries: { "builtin/memory": "on@team:b_team" },
    ignored: {},
  },
  {
    name: "the whole ladder, narrowest wins",
    bindings: [
      binding({ id: "b_team", scopeKind: "team", teamId: TEAM, enabled: true }),
      binding({ id: "b_user", scopeKind: "user", enabled: false }),
      binding({ id: "b_device", scopeKind: "device", enabled: true }),
      binding({ id: "b_project", scopeKind: "project", enabled: false }),
      binding({ id: "b_session", scopeKind: "session", enabled: true }),
    ],
    context: GOLDEN_CONTEXT,
    entries: { "builtin/memory": "on@session:b_session" },
    ignored: {},
  },
  {
    name: "a device disable revokes a team enable",
    bindings: [
      binding({ id: "b_team", scopeKind: "team", teamId: TEAM, enabled: true }),
      binding({ id: "b_device", scopeKind: "device", enabled: false }),
    ],
    context: GOLDEN_CONTEXT,
    entries: { "builtin/memory": "off@device:b_device" },
    ignored: {},
  },
  {
    name: "a project enable revives a user disable",
    bindings: [
      binding({ id: "b_user", scopeKind: "user", enabled: false }),
      binding({ id: "b_project", scopeKind: "project", enabled: true }),
    ],
    context: GOLDEN_CONTEXT,
    entries: { "builtin/memory": "on@project:b_project" },
    ignored: {},
  },
  {
    name: "same scope: the later write wins",
    bindings: [
      binding({ id: "b_old", scopeKind: "user", enabled: true, updatedAt: 10 }),
      binding({ id: "b_new", scopeKind: "user", enabled: false, updatedAt: 20 }),
    ],
    context: GOLDEN_CONTEXT,
    entries: { "builtin/memory": "off@user:b_new" },
    ignored: {},
  },
  {
    name: "same scope and same instant: the lexically first row id wins",
    bindings: [
      binding({ id: "b_zzz", scopeKind: "user", enabled: true, updatedAt: 20 }),
      binding({ id: "b_aaa", scopeKind: "user", enabled: false, updatedAt: 20 }),
    ],
    context: GOLDEN_CONTEXT,
    entries: { "builtin/memory": "off@user:b_aaa" },
    ignored: {},
  },
  {
    name: "bindings for somewhere else never apply",
    bindings: [
      binding({ id: "b_here", scopeKind: "user", enabled: true }),
      binding({ id: "b_other_device", scopeKind: "device", scopeKey: "device_mbp", enabled: false }),
      binding({ id: "b_other_project", scopeKind: "project", scopeKey: "git:github.com/ashot/mail", enabled: false }),
      binding({ id: "b_other_session", scopeKind: "session", scopeKey: "conv_other", enabled: false }),
      binding({ id: "b_other_team", scopeKind: "team", scopeKey: "team_other", teamId: "team_other", enabled: false }),
      binding({ id: "b_other_user", scopeKind: "user", scopeKey: "user_sam", userId: "user_sam", enabled: false }),
    ],
    context: GOLDEN_CONTEXT,
    entries: { "builtin/memory": "on@user:b_here" },
    ignored: {
      b_other_device: "scope_not_in_context",
      b_other_project: "scope_not_in_context",
      b_other_session: "scope_not_in_context",
      b_other_team: "scope_not_in_context",
      b_other_user: "scope_not_in_context",
    },
  },
  {
    name: "a client filter excludes the client being resolved for",
    bindings: [
      binding({ id: "b_codex_only", scopeKind: "user", clientFilter: ["codex"] }),
      binding({ id: "b_any", scopeKind: "user", capabilitySlug: "builtin/tasks" }),
    ],
    context: GOLDEN_CONTEXT,
    entries: { "builtin/tasks": "on@user:b_any" },
    ignored: { b_codex_only: "client_filtered" },
  },
  {
    name: "a teammate's config is withheld, the owner's own is used",
    bindings: [
      binding({
        id: "b_team_config",
        scopeKind: "team",
        teamId: TEAM,
        capabilitySlug: "mkt/acme/deploy",
        config: { REGION: "us-east-1" },
        userId: "user_sam",
      }),
      binding({
        id: "b_own_config",
        scopeKind: "device",
        capabilitySlug: "mcp/io.github.acme/server",
        config: { TOKEN_NAME: "acme" },
      }),
    ],
    context: GOLDEN_CONTEXT,
    entries: {
      "mcp/io.github.acme/server": "on@device:b_own_config",
      "mkt/acme/deploy": "withheld:config_scope_not_trusted@team:b_team_config",
    },
    ignored: {},
  },
  {
    name: "a malformed row costs one capability, not the machine",
    bindings: [
      { ...binding({ id: "b_bad", scopeKind: "user" }), scopeKind: "org" as never },
      binding({ id: "b_good", scopeKind: "user", capabilitySlug: "builtin/tasks" }),
    ],
    context: GOLDEN_CONTEXT,
    entries: { "builtin/tasks": "on@user:b_good" },
    ignored: { b_bad: "malformed_binding" },
  },
];
