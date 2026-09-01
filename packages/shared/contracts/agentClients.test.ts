import { describe, expect, it } from "bun:test";
import {
  AGENT_CLIENTS,
  AGENT_LAUNCH_OPTIONS,
  launchRailOptions,
  agentSupportsExecutionTransport,
  capabilitySupport,
  fromConvexAgentType,
  InvalidExecutionAgentTypeError,
  parseExecutionAgentClientId,
  toConvexAgentType,
  type AgentClientId,
  type CapabilityKindSupport,
} from "./agentClients";
import { CAPABILITY_KINDS, type CapabilityKind } from "./capabilities";

// fromConvexAgentType is the single convex-spelling -> daemon-spelling translation.
// The daemon launch/resume mutations (users.startSession, conversations.switchSessionAgent,
// tasks.assignToAgent) delegate their daemon-agent decision to it — those sites are
// mutation-wrapped and have no plain-function seam, so this unit test is the guard.
// Load-bearing cases: (1) "cursor" must pass through — a 2-branch ternary
// (codex/gemini else claude) used to collapse it to "claude", so cursor sessions
// resumed as `claude --resume`; (2) "opencode" (phase 1) and "pi" (phase 2) are
// first-class and must map to themselves — resuming either as `claude --resume`
// would be wrong. tsc can't catch a wrong-but-valid AgentClientId.
describe("fromConvexAgentType", () => {
  it("maps every current convex spelling to its daemon id", () => {
    expect(fromConvexAgentType("claude_code")).toBe("claude");
    expect(fromConvexAgentType("codex")).toBe("codex");
    expect(fromConvexAgentType("cursor")).toBe("cursor");
    expect(fromConvexAgentType("gemini")).toBe("gemini");
    expect(fromConvexAgentType("opencode")).toBe("opencode");
    expect(fromConvexAgentType("pi")).toBe("pi");
    expect(fromConvexAgentType("grok")).toBe("grok");
  });

  it("normalizes cowork, unknown, null and undefined to claude", () => {
    expect(fromConvexAgentType("cowork")).toBe("claude");
    expect(fromConvexAgentType("whatever")).toBe("claude");
    expect(fromConvexAgentType(null)).toBe("claude");
    expect(fromConvexAgentType(undefined)).toBe("claude");
  });
});

describe("toConvexAgentType", () => {
  it("round-trips each daemon id back to its convex spelling", () => {
    expect(toConvexAgentType("claude")).toBe("claude_code");
    expect(toConvexAgentType("codex")).toBe("codex");
    expect(toConvexAgentType("cursor")).toBe("cursor");
    expect(toConvexAgentType("gemini")).toBe("gemini");
    expect(toConvexAgentType("opencode")).toBe("opencode");
    expect(toConvexAgentType("pi")).toBe("pi");
    expect(toConvexAgentType("grok")).toBe("grok");
  });
});

describe("parseExecutionAgentClientId", () => {
  it("accepts every canonical execution id and explicit compatibility alias", () => {
    expect(parseExecutionAgentClientId("claude")).toBe("claude");
    expect(parseExecutionAgentClientId("claude_code")).toBe("claude");
    expect(parseExecutionAgentClientId("cowork")).toBe("claude");
    expect(parseExecutionAgentClientId("codex")).toBe("codex");
    expect(parseExecutionAgentClientId("cursor")).toBe("cursor");
    expect(parseExecutionAgentClientId("gemini")).toBe("gemini");
    expect(parseExecutionAgentClientId("opencode")).toBe("opencode");
    expect(parseExecutionAgentClientId("pi")).toBe("pi");
    expect(parseExecutionAgentClientId("grok")).toBe("grok");
  });

  it("fails closed for unknown, nullish, and non-string execution values", () => {
    for (const value of ["whatever", "", null, undefined, 1, {}]) {
      expect(() => parseExecutionAgentClientId(value)).toThrow(InvalidExecutionAgentTypeError);
    }
  });

  it("does not change the permissive legacy/display parser", () => {
    expect(fromConvexAgentType("whatever")).toBe("claude");
    expect(fromConvexAgentType(null)).toBe("claude");
  });
});

describe("print mode", () => {
  it("declares a print mode for every client", () => {
    for (const [id, d] of Object.entries(AGENT_CLIENTS)) {
      expect(d.printMode, id).toBeDefined();
      expect(["flag", "subcommand"]).toContain(d.printMode.kind);
      expect(d.printMode.token.length).toBeGreaterThan(0);
    }
  });

  it("uses -p for flag clients and a subcommand for codex/opencode", () => {
    expect(AGENT_CLIENTS.claude.printMode).toEqual({ kind: "flag", token: "-p" });
    expect(AGENT_CLIENTS.cursor.printMode).toEqual({ kind: "flag", token: "-p" });
    expect(AGENT_CLIENTS.pi.printMode).toEqual({ kind: "flag", token: "-p" });
    expect(AGENT_CLIENTS.grok.printMode).toEqual({ kind: "flag", token: "-p", promptAsValue: true });
    expect(AGENT_CLIENTS.gemini.printMode).toEqual({ kind: "flag", token: "-p", promptAsValue: true });
    expect(AGENT_CLIENTS.codex.printMode).toEqual({ kind: "subcommand", token: "exec" });
    expect(AGENT_CLIENTS.opencode.printMode).toEqual({ kind: "subcommand", token: "run" });
  });
});

describe("fenced execution transports", () => {
  it("declares the exact implemented transport set for every agent family", () => {
    expect(AGENT_CLIENTS.claude.executionTransports).toEqual(["tmux"]);
    expect(AGENT_CLIENTS.codex.executionTransports).toEqual(["tmux", "app-server"]);
    expect(AGENT_CLIENTS.cursor.executionTransports).toEqual(["tmux"]);
    expect(AGENT_CLIENTS.gemini.executionTransports).toEqual(["tmux"]);
    expect(AGENT_CLIENTS.opencode.executionTransports).toEqual(["tmux"]);
    expect(AGENT_CLIENTS.pi.executionTransports).toEqual(["tmux"]);
    expect(AGENT_CLIENTS.grok.executionTransports).toEqual(["tmux"]);
  });

  it("rejects unsupported app-server and external routing without fallback", () => {
    expect(agentSupportsExecutionTransport("codex", "app-server")).toBe(true);
    expect(agentSupportsExecutionTransport("claude", "app-server")).toBe(false);
    expect(agentSupportsExecutionTransport("opencode", "app-server")).toBe(false);
    for (const agent of Object.keys(AGENT_CLIENTS) as Array<keyof typeof AGENT_CLIENTS>) {
      expect(agentSupportsExecutionTransport(agent, "external")).toBe(false);
    }
  });
});

// The new-session agent row (web AgentSwitcher + mobile sheet) renders from
// AGENT_LAUNCH_OPTIONS; the launch model/effort rail from launchRailOptions.
// Both are pure registry derivations — these tests pin the shape each surface
// relies on (six clients, honest labels, launch rail hides picker-only models
// and prepends the "default" effort stop).
describe("new-session launch options", () => {
  it("derives one launch option per registry client, in declaration order", () => {
    expect(AGENT_LAUNCH_OPTIONS.map((a) => a.id)).toEqual(
      Object.keys(AGENT_CLIENTS) as Array<keyof typeof AGENT_CLIENTS>,
    );
    for (const opt of AGENT_LAUNCH_OPTIONS) {
      expect(opt.convexType).toBe(AGENT_CLIENTS[opt.id].convexId);
      expect(opt.label).toBe(AGENT_CLIENTS[opt.id].displayName);
      expect(opt.label.length).toBeGreaterThan(0);
    }
  });

  it("launch rail prepends the default effort stop", () => {
    const claude = launchRailOptions(AGENT_CLIENTS.claude.modelConfig!);
    expect(claude.models.some((m) => m.key === "opus")).toBe(true);
    expect(claude.efforts).toEqual(["default", "low", "medium", "high", "max"]);

    // No-effort clients still get the default stop (opencode's effort list is empty).
    const opencode = launchRailOptions(AGENT_CLIENTS.opencode.modelConfig!);
    expect(opencode.efforts).toEqual(["default"]);
  });
});

// capabilitySupport is derived from agentFileTargets — the same slots a driver
// reads — so these tests pin the DERIVATION against a hand-written oracle of
// what was actually verified on real machines (scratchpad research 2026-08-12/13).
// A cell drifting here means either a target slot changed without its verified
// fact, or the derivation broke — both are the "UI says supported, driver writes
// nothing" bug this function exists to prevent.
describe("capabilitySupport", () => {
  const ALL_CLIENTS = Object.keys(AGENT_CLIENTS) as AgentClientId[];

  // The full verified matrix. Load-bearing cells: claude/mcp native (claude mcp
  // is the safe writer for ~/.claude.json), claude/plugin render (settings.json
  // enabledPlugins is the mechanism, not `claude plugin install`), codex/hook
  // write (installStableHookCodex already writes ~/.codex/hooks.json),
  // cursor/subagent and cursor/hook unsupported (format/shape unverified).
  const ORACLE: Record<AgentClientId, Record<CapabilityKind, CapabilityKindSupport>> = {
    claude: {
      snippet: "write",
      skill: "write",
      command: "unsupported",
      subagent: "write",
      mcp: "native",
      plugin: "render",
      hook: "write",
    },
    codex: {
      snippet: "write",
      skill: "write",
      command: "unsupported",
      subagent: "unsupported",
      mcp: "native",
      plugin: "unsupported",
      hook: "write",
    },
    cursor: {
      snippet: "write",
      skill: "write",
      command: "unsupported",
      subagent: "unsupported",
      mcp: "write",
      plugin: "unsupported",
      hook: "unsupported",
    },
    gemini: {
      snippet: "unsupported",
      skill: "unsupported",
      command: "unsupported",
      subagent: "unsupported",
      mcp: "unsupported",
      plugin: "unsupported",
      hook: "unsupported",
    },
    opencode: {
      snippet: "unsupported",
      skill: "unsupported",
      command: "unsupported",
      subagent: "unsupported",
      mcp: "unsupported",
      plugin: "unsupported",
      hook: "unsupported",
    },
    pi: {
      snippet: "unsupported",
      skill: "unsupported",
      command: "unsupported",
      subagent: "unsupported",
      mcp: "unsupported",
      plugin: "unsupported",
      hook: "unsupported",
    },
    // Verified 2026-08-26 (planted-file `grok inspect` in a sandbox HOME, works
    // logged out): AGENTS.md instruction slots and all four skills dirs load;
    // `grok mcp` is the native MCP manager. Hooks (a config DIRECTORY), plugins
    // (`grok plugin` semantics unverified) and subagents stay honestly
    // unsupported.
    grok: {
      snippet: "write",
      skill: "write",
      command: "unsupported",
      subagent: "unsupported",
      mcp: "native",
      plugin: "unsupported",
      hook: "unsupported",
    },
  };

  it("answers a defined support value for every (kind, client) pair", () => {
    for (const client of ALL_CLIENTS) {
      for (const kind of CAPABILITY_KINDS) {
        const support = capabilitySupport(kind, client);
        expect(["native", "write", "render", "unsupported"]).toContain(support);
      }
    }
  });

  it("matches the verified oracle matrix cell for cell", () => {
    for (const client of ALL_CLIENTS) {
      for (const kind of CAPABILITY_KINDS) {
        expect(`${client}/${kind}=${capabilitySupport(kind, client)}`).toBe(
          `${client}/${kind}=${ORACLE[client][kind]}`,
        );
      }
    }
  });

  it("clients without verified file targets are wholly unsupported (honest absence)", () => {
    for (const client of ["gemini", "opencode", "pi"] as const) {
      expect(AGENT_CLIENTS[client].agentFileTargets).toBeUndefined();
      for (const kind of CAPABILITY_KINDS) {
        expect(capabilitySupport(kind, client)).toBe("unsupported");
      }
    }
  });

  // Adversarial: the strict AgentClientId type is one `as` cast away from a raw
  // wire string ("claude_code", agent_type values convex/web pass around). An
  // out-of-registry value must ANSWER "unsupported" — true of an unknown client
  // — never crash with a TypeError on `.agentFileTargets` of undefined.
  it("answers unsupported for out-of-registry strings instead of throwing", () => {
    for (const bogus of ["claude_code", "cowork", "whatever", ""]) {
      for (const kind of CAPABILITY_KINDS) {
        expect(capabilitySupport(kind, bogus as AgentClientId)).toBe("unsupported");
      }
    }
  });
});

// The path invariant: this module is isomorphic (Convex/browser/Hermes) and
// cannot resolve a home directory, so every declared target must be a portable
// TEMPLATE — user-level paths start with the `~/` placeholder, project-level
// paths are repo-root-relative, and nothing is ever a resolved absolute path or
// uses a platform separator.
describe("agentFileTargets path templates", () => {
  const withTargets = Object.values(AGENT_CLIENTS).filter((d) => d.agentFileTargets);

  it("declares targets for exactly the verified clients", () => {
    expect(withTargets.map((d) => d.id).sort()).toEqual(["claude", "codex", "cursor", "grok"]);
  });

  // The cross-client `.agents/skills` project dir is read by cursor (via
  // sharedProject) AND codex (its project slot IS that dir). The two claims are
  // coupled: a driver writing codex project skills silently serves cursor, and
  // the fleet mirror attributes the dir to both. Claude reads neither the
  // shared user dir nor the shared project dir (symlink-only) — a slot
  // appearing there would tell a driver to write bytes claude never loads.
  it("pins who reads the cross-client .agents/skills project dir", () => {
    expect(AGENT_CLIENTS.cursor.agentFileTargets?.skillsDir?.sharedProject).toBe(".agents/skills");
    // grok reads both the shared user dir and the shared project dir directly
    // (skills.rs lookup order; all four verified live by inspect).
    expect(AGENT_CLIENTS.grok.agentFileTargets?.skillsDir?.shared).toBe("~/.agents/skills");
    expect(AGENT_CLIENTS.grok.agentFileTargets?.skillsDir?.sharedProject).toBe(".agents/skills");
    expect(AGENT_CLIENTS.codex.agentFileTargets?.skillsDir?.project).toBe(".agents/skills");
    expect(AGENT_CLIENTS.codex.agentFileTargets?.skillsDir?.sharedProject).toBeUndefined();
    expect(AGENT_CLIENTS.claude.agentFileTargets?.skillsDir?.shared).toBeUndefined();
    expect(AGENT_CLIENTS.claude.agentFileTargets?.skillsDir?.sharedProject).toBeUndefined();
  });

  it("user-level paths are ~/ templates; project paths are repo-relative; none absolute", () => {
    for (const d of withTargets) {
      const t = d.agentFileTargets!;
      const userLevel = [
        t.instructionFile?.user,
        t.skillsDir?.user,
        t.skillsDir?.shared,
        t.agentsDir?.user,
        t.mcpConfig?.user,
        t.pluginSettings?.user,
        t.hooksConfig?.path,
      ].filter((p): p is string => p !== undefined);
      const projectLevel = [
        t.instructionFile?.project,
        t.skillsDir?.project,
        t.skillsDir?.sharedProject,
        t.agentsDir?.project,
        t.mcpConfig?.project,
        t.pluginSettings?.project,
        t.pluginSettings?.local,
      ].filter((p): p is string => p !== undefined);

      // Each client must declare at least one target on both sides — an empty
      // agentFileTargets object would grant nothing while looking populated.
      expect(userLevel.length).toBeGreaterThan(0);
      expect(projectLevel.length).toBeGreaterThan(0);

      for (const p of userLevel) {
        expect(p.startsWith("~/")).toBe(true);
      }
      for (const p of projectLevel) {
        expect(p.startsWith("~")).toBe(false);
      }
      for (const p of [...userLevel, ...projectLevel]) {
        expect(p.startsWith("/")).toBe(false);
        expect(p.includes("\\")).toBe(false);
      }
    }
  });
});
