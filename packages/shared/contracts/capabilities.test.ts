import { describe, expect, it } from "bun:test";
import {
  BENIGN_EXECUTION_SURFACES,
  CAPABILITY_KINDS,
  CAPABILITY_SOURCES,
  CAPABILITY_SOURCE_PREFIX,
  EXECUTION_SURFACES,
  MATERIALIZABLE_KINDS,
  MAX_CAPABILITY_SLUG_LENGTH,
  OBSERVED_SCOPES,
  RESERVED_SLUG_PREFIXES,
  SCOPE_KINDS,
  SCOPE_PRECEDENCE,
  capabilitySlugSource,
  compareScopeNarrowness,
  deriveExecutionSurfaces,
  formatCapabilitySlug,
  formatReservedSlug,
  isCapabilityKind,
  isCapabilitySource,
  isExecutionSurface,
  isMaterializableKind,
  isObservedScope,
  isScopeKind,
  isWellFormedCapabilitySlug,
  manifestHash,
  parseAnyCapabilitySlug,
  parseCapabilitySlug,
  requiresExplicitConsent,
  scopePrecedence,
  slugMatchesSource,
  type ScopeKind,
} from "./capabilities.js";

describe("capability enums", () => {
  it("has no duplicate members in any enum", () => {
    for (const list of [
      CAPABILITY_KINDS,
      CAPABILITY_SOURCES,
      EXECUTION_SURFACES,
      SCOPE_KINDS,
      OBSERVED_SCOPES,
      MATERIALIZABLE_KINDS,
    ]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("guards accept their own members and reject neighbours", () => {
    for (const k of CAPABILITY_KINDS) expect(isCapabilityKind(k)).toBe(true);
    for (const s of CAPABILITY_SOURCES) expect(isCapabilitySource(s)).toBe(true);
    for (const s of EXECUTION_SURFACES) expect(isExecutionSurface(s)).toBe(true);
    for (const s of SCOPE_KINDS) expect(isScopeKind(s)).toBe(true);
    for (const s of OBSERVED_SCOPES) expect(isObservedScope(s)).toBe(true);

    // `local` is an OBSERVED scope (a settings file), never a binding scope.
    // Confusing the two would let a settings file name a scope the resolver
    // ranks, which is the merge this contract exists to prevent.
    expect(isScopeKind("local")).toBe(false);
    expect(isObservedScope("device")).toBe(false);
    expect(isCapabilityKind("mcp_server")).toBe(false);
    expect(isCapabilityKind(undefined)).toBe(false);
    expect(isCapabilitySource("marketplace_v2")).toBe(false);
  });

  it("keeps `command` readable but never materializable", () => {
    expect(isCapabilityKind("command")).toBe(true);
    expect(isMaterializableKind("command")).toBe(false);
    // Everything else a machine can carry is writable by some driver.
    const rest = CAPABILITY_KINDS.filter((k) => k !== "command");
    for (const k of rest) expect(isMaterializableKind(k)).toBe(true);
  });

  it("gives every source a distinct slug prefix, and maps back one to one", () => {
    const prefixes = CAPABILITY_SOURCES.map((s) => CAPABILITY_SOURCE_PREFIX[s]);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const source of CAPABILITY_SOURCES) {
      const slug = formatCapabilitySlug(
        source === "git" ? { source, segments: ["x"], pin: "abc123" } : { source, segments: ["x"] },
      );
      expect(capabilitySlugSource(slug)).toBe(source);
    }
  });
});

describe("scope ladder", () => {
  it("ranks every scope uniquely, narrowest highest", () => {
    const ranks = SCOPE_KINDS.map((s) => SCOPE_PRECEDENCE[s]);
    expect(new Set(ranks).size).toBe(ranks.length);
    expect(scopePrecedence("session")).toBeGreaterThan(scopePrecedence("project"));
    expect(scopePrecedence("project")).toBeGreaterThan(scopePrecedence("device"));
    expect(scopePrecedence("device")).toBeGreaterThan(scopePrecedence("user"));
    expect(scopePrecedence("user")).toBeGreaterThan(scopePrecedence("team"));
  });

  it("sorts narrowest first with the comparator", () => {
    const shuffled: ScopeKind[] = ["user", "session", "team", "project", "device"];
    expect([...shuffled].sort(compareScopeNarrowness)).toEqual([
      "session",
      "project",
      "device",
      "user",
      "team",
    ]);
  });
});

describe("capability slugs", () => {
  it("round trips every shape", () => {
    const cases = [
      { source: "builtin" as const, segments: ["memory"] },
      { source: "marketplace" as const, segments: ["claude-plugins-official", "code-simplifier"] },
      { source: "mcp_registry" as const, segments: ["io.github.foo", "server"] },
      { source: "authored" as const, segments: ["ashot", "deploy-checklist"] },
      { source: "git" as const, segments: ["anthropics", "skills"], pin: "30287f5", subpath: "skills/pdf" },
      { source: "git" as const, segments: ["anthropics", "skills"], pin: "v1.2.0" },
    ];
    for (const ref of cases) {
      const slug = formatCapabilitySlug(ref);
      expect(slug).not.toBeNull();
      const parsed = parseCapabilitySlug(slug);
      expect(parsed).toMatchObject({ ...ref, slug: slug! });
    }
  });

  it("renders the documented spellings", () => {
    expect(formatCapabilitySlug({ source: "builtin", segments: ["memory"] })).toBe("builtin/memory");
    expect(
      formatCapabilitySlug({ source: "marketplace", segments: ["claude-plugins-official", "code-simplifier"] }),
    ).toBe("mkt/claude-plugins-official/code-simplifier");
    expect(
      formatCapabilitySlug({
        source: "git",
        segments: ["anthropics", "skills"],
        pin: "30287f5",
        subpath: "skills/pdf",
      }),
    ).toBe("git/anthropics/skills@30287f5#skills/pdf");
  });

  it("refuses anything that could escape a directory or fake a name", () => {
    const bad = [
      "",
      "builtin",
      "builtin/",
      "builtin//memory",
      "builtin/../../etc/passwd",
      "builtin/.",
      "builtin/..",
      "builtin/mem\tory",
      "builtin/mem\nory",
      "builtin/mеmory", // Cyrillic "е" — a confusable, rejected as non-ASCII
      "builtin/mem ory",
      "builtin/mem\u0000ory",
      "builtin/mémoire",
      "unknown/memory",
      "/builtin/memory",
      " builtin/memory",
      "builtin/memory ",
      "builtin/-leading-hyphen",
    ];
    for (const slug of bad) expect(parseCapabilitySlug(slug)).toBeNull();
    expect(parseCapabilitySlug(42)).toBeNull();
    expect(parseCapabilitySlug(undefined)).toBeNull();
  });

  it("allows `@` and `#` only on a git slug", () => {
    expect(parseCapabilitySlug("builtin/memory@abc")).toBeNull();
    expect(parseCapabilitySlug("mkt/acme/thing#sub")).toBeNull();
    expect(formatCapabilitySlug({ source: "builtin", segments: ["memory"], pin: "abc" })).toBeNull();
    expect(parseCapabilitySlug("git/a/b@sha#p")).not.toBeNull();
  });

  it("holds the same grammar in the pin and subpath positions", () => {
    // The bad-input sweep above only exercises the segment position, and the
    // subpath is the position that matters most: it is joined onto a content
    // store path, so a `..` there escapes the store rather than merely naming a
    // capability that does not exist.
    for (const slug of [
      "git/a/b@sha#p/../q", // traversal inside a subpath
      "git/a/b@sha#/abs", // absolute-looking subpath
      "git/a/b@sha#p#q", // a second `#`, which lands inside the subpath
      "git/a/b@sha#", // an empty subpath is not the same as none
      "git/a/b@#p", // an empty pin names no bytes
      "git/a/b@../../etc", // traversal in the pin
      "GIT/a/b@sha", // the prefix is matched exactly, never case folded
    ]) {
      expect(parseAnyCapabilitySlug(slug)).toBeNull();
    }
    // The writer refuses what the reader refuses, so no caller can mint one.
    expect(formatCapabilitySlug({ source: "git", segments: ["a"], pin: "sha", subpath: "p/../q" })).toBeNull();
    expect(formatCapabilitySlug({ source: "git", segments: ["a"], pin: "sha", subpath: "" })).toBeNull();
  });

  it("bounds the length", () => {
    const long = "a".repeat(MAX_CAPABILITY_SLUG_LENGTH);
    expect(formatCapabilitySlug({ source: "builtin", segments: [long] })).toBeNull();
    expect(parseCapabilitySlug(`builtin/${long}`)).toBeNull();
  });

  it("parses the two reserved namespaces, and refuses them a source", () => {
    // A loadout and a connector are legal `capability_slug` values with no
    // bytes behind them. The grammar has to accept them or the resolver drops
    // every loadout row as malformed; the typed parse has to refuse them or a
    // driver is handed something it cannot materialize.
    for (const slug of ["loadout/lo-12", "connector/slack"]) {
      expect(parseAnyCapabilitySlug(slug)).toMatchObject({ slug, source: null });
      expect(isWellFormedCapabilitySlug(slug)).toBe(true);
      expect(parseCapabilitySlug(slug)).toBeNull();
      expect(capabilitySlugSource(slug)).toBeNull();
    }
    // Reserved means unclaimable, exactly like `builtin/`.
    for (const source of CAPABILITY_SOURCES) {
      expect(slugMatchesSource("connector/slack", source)).toBe(false);
      expect(slugMatchesSource("loadout/lo-12", source)).toBe(false);
    }
    // The grammar is the same grammar — no second set of rules crept in.
    for (const slug of ["loadout/../etc", "connector", "loadout/lo-12@sha", "connector/slack#x"]) {
      expect(parseAnyCapabilitySlug(slug)).toBeNull();
      expect(isWellFormedCapabilitySlug(slug)).toBe(false);
    }
  });

  it("builds a reserved slug through the same validation it will be read with", () => {
    // A writer that concatenated `loadout/${id}` by hand would persist a row the
    // resolver then drops as malformed — a wish that never lands, on one
    // machine, for no visible reason.
    expect(formatReservedSlug("loadout", ["lo-12"])).toBe("loadout/lo-12");
    expect(formatReservedSlug("connector", ["slack"])).toBe("connector/slack");
    expect(formatReservedSlug("loadout", ["lo/12"])).toBeNull();
    expect(formatReservedSlug("loadout", [".."])).toBeNull();
    expect(formatReservedSlug("loadout", [])).toBeNull();
    expect(formatReservedSlug("builtin" as never, ["memory"])).toBeNull();
    for (const slug of [formatReservedSlug("loadout", ["lo-12"]), formatReservedSlug("connector", ["slack"])]) {
      expect(isWellFormedCapabilitySlug(slug)).toBe(true);
    }
  });

  it("covers every namespace the design reserves", () => {
    // Adding a namespace to the design and not to the grammar is the failure
    // this asserts against: the resolver would call those rows malformed.
    const prefixes: string[] = [
      ...CAPABILITY_SOURCES.map((s) => CAPABILITY_SOURCE_PREFIX[s]),
      ...RESERVED_SLUG_PREFIXES,
    ];
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(prefixes.sort()).toEqual(
      ["authored", "builtin", "connector", "git", "loadout", "mcp", "mkt"].sort(),
    );
  });

  it("stops a third party claiming a builtin name", () => {
    // The hijack: a marketplace entry whose slug reads as one of ours. The
    // prefix decides the source, so ingest can never be talked into storing it.
    expect(slugMatchesSource("builtin/memory", "marketplace")).toBe(false);
    expect(slugMatchesSource("builtin/memory", "builtin")).toBe(true);
    expect(slugMatchesSource("mkt/evil/builtin", "marketplace")).toBe(true);
    expect(slugMatchesSource("nonsense", "builtin")).toBe(false);
  });
});

describe("execution surfaces", () => {
  it("treats only prose and file reading as consent free", () => {
    expect(requiresExplicitConsent(["prose"])).toBe(false);
    expect(requiresExplicitConsent(["prose", "reads_files"])).toBe(false);
    for (const surface of EXECUTION_SURFACES) {
      if ((BENIGN_EXECUTION_SURFACES as readonly string[]).includes(surface)) continue;
      expect(requiresExplicitConsent(["prose", surface])).toBe(true);
    }
  });

  it("treats an unclassified capability as dangerous", () => {
    // A failed classification must not read as "markdown only" — that would
    // turn a parsing bug into a silent install.
    expect(requiresExplicitConsent(undefined)).toBe(true);
    expect(requiresExplicitConsent([])).toBe(true);
  });
});

// `MATERIALIZABLE_KINDS ⊆ CAPABILITY_KINDS` is not asserted here: the
// `satisfies readonly CapabilityKind[]` on the declaration is a build failure,
// which is strictly stronger than a test, and the `command` case above already
// pins which kinds are on each side.

// ------------------------------------------------- the manifest and its hash

// Consent is granted against the manifest, so these properties are the ones the
// consent gate rests on: two scanners must agree on the same capability, any
// change to what will run must change the hash, and a publisher must never be
// able to talk their way to a quieter badge.
describe("manifestHash", () => {
  it("is stable under key reordering at every depth", () => {
    const a = manifestHash({
      bin: ["run"],
      mcp: [{ name: "s", command: "node s.js" }],
      hooks: ["PreToolUse"],
    });
    const b = manifestHash({
      hooks: ["PreToolUse"],
      mcp: [{ command: "node s.js", name: "s" }],
      bin: ["run"],
    });
    expect(a).toBe(b);
  });

  it("changes when anything that will run changes", () => {
    const base = { mcp: [{ command: "node server.js" }] };
    const hash = manifestHash(base);
    expect(manifestHash({ mcp: [{ command: "node other.js" }] })).not.toBe(hash);
    expect(manifestHash({ ...base, hooks: ["PreToolUse"] })).not.toBe(hash);
    expect(manifestHash({ ...base, envKeys: ["API_KEY"] })).not.toBe(hash);
    expect(manifestHash({ ...base, allowedTools: ["Bash"] })).not.toBe(hash);
  });

  it("array order is meaningful — arguments are not a set", () => {
    expect(manifestHash({ bin: ["a", "b"] })).not.toBe(manifestHash({ bin: ["b", "a"] }));
  });

  it("an absent manifest hashes like an empty one, and never throws", () => {
    expect(manifestHash(undefined)).toBe(manifestHash({}));
  });

  it("hashes the component inventory too, not only the executable fields", () => {
    // The doc promises consent covers the component inventory. A plugin that
    // grows a hook component is a different thing to approve, even before any
    // scanner fills the dedicated `hooks` field.
    const base = { components: { skill: ["a"] } };
    expect(manifestHash({ components: { skill: ["a", "b"] } })).not.toBe(manifestHash(base));
    expect(manifestHash({ components: { skill: ["a"], hook: ["h"] } })).not.toBe(manifestHash(base));
    expect(manifestHash({ components: { hook: ["h"], skill: ["a"] } })).toBe(
      manifestHash({ components: { skill: ["a"], hook: ["h"] } }),
    );
  });

  it("separates a local command from a remote endpoint", () => {
    // Same server name, entirely different thing to consent to: one runs a
    // process on this machine, the other talks to somebody else's.
    expect(manifestHash({ mcp: [{ name: "s", command: "node s.js" }] })).not.toBe(
      manifestHash({ mcp: [{ name: "s", url: "https://x/mcp" }] }),
    );
  });

  it("every spelling of 'this field says nothing' hashes alike", () => {
    // Scanners disagree about whether an unpopulated field is omitted, set to
    // undefined, or set to an empty container. All three describe the same
    // capability, and `deriveExecutionSurfaces` already reads them alike. A hash
    // that split them would fire the consent gate's "the manifest changed since
    // you approved it" on a capability that did not change — re-prompting a
    // human for nothing, which is how a prompt stops being read.
    const spellings = [
      { bin: ["x"] },
      { bin: ["x"], scripts: undefined },
      { bin: ["x"], scripts: [], hooks: [], mcp: [], allowedTools: [], envKeys: [] },
      // Emptiness one level down must not survive either: this collapses to an
      // empty `components`, which is an absent `components`.
      { bin: ["x"], components: {} },
      { bin: ["x"], components: { skill: [], hook: [] } },
    ];
    const hashes = new Set(spellings.map(manifestHash));
    expect(hashes.size).toBe(1);
    // …and every one of them derives the same surfaces, which is the agreement
    // being pinned: the hash must not be stricter than the semantics.
    const surfaces = new Set(spellings.map((m) => deriveExecutionSurfaces(m).join(",")));
    expect(surfaces.size).toBe(1);
  });

  it("an empty container is absent, but a populated one is never dropped", () => {
    // The other half of the rule. Collapsing `[{}]` to `[]` would shorten a list
    // whose length is meaningful — an observed server we learned nothing about
    // is still an observed server.
    expect(manifestHash({ mcp: [{}] })).not.toBe(manifestHash({}));
    expect(manifestHash({ mcp: [{}, {}] })).not.toBe(manifestHash({ mcp: [{}] }));
  });
});

describe("deriveExecutionSurfaces", () => {
  it("reads each surface off the structure that implies it", () => {
    expect(deriveExecutionSurfaces({ bin: ["run"] })).toContain("ships_bin");
    expect(deriveExecutionSurfaces({ scripts: ["s.sh"] })).toContain("ships_scripts");
    expect(deriveExecutionSurfaces({ hooks: ["PreToolUse"] })).toContain("declares_hooks");
    expect(deriveExecutionSurfaces({ allowedTools: ["Bash"] })).toContain("declares_allowed_tools");
    expect(deriveExecutionSurfaces({ mcp: [{ command: "node s.js" }] })).toContain("mcp_stdio_command");
    expect(deriveExecutionSurfaces({ mcp: [{ url: "https://x/mcp" }] })).toContain("mcp_remote_url");
  });

  it("an empty list is empty — and that reads as dangerous, not benign", () => {
    expect(deriveExecutionSurfaces({})).toEqual([]);
    expect(deriveExecutionSurfaces(undefined)).toEqual([]);
    // The contract's deliberate rule: nothing observed means nothing looked.
    expect(requiresExplicitConsent(deriveExecutionSurfaces({}))).toBe(true);
  });

  it("a declared list RAISES risk", () => {
    const surfaces = deriveExecutionSurfaces({}, ["ships_bin"]);
    expect(surfaces).toContain("ships_bin");
    expect(requiresExplicitConsent(surfaces)).toBe(true);
  });

  it("a declared list can NEVER lower risk", () => {
    // The whole asymmetry: a publisher claiming "prose" over a capability that
    // ships a binary must not get the quieter badge.
    const surfaces = deriveExecutionSurfaces({ bin: ["run"] }, ["prose"]);
    expect(surfaces).toContain("ships_bin");
    expect(requiresExplicitConsent(surfaces)).toBe(true);
  });

  it("a bogus declared value is ignored rather than trusted", () => {
    const surfaces = deriveExecutionSurfaces({ bin: ["run"] }, ["totally-made-up" as never]);
    expect(surfaces).toEqual(["ships_bin"]);
  });

  it("reads the dedicated fields only, and a components-only manifest fails safe", () => {
    // `components` counts the files a capability SHIPS; `hooks`/`mcp`/`bin` name
    // what it REGISTERS. Only the second group is derived from, because a
    // component list cannot tell a local MCP command from a remote url — the two
    // are different surfaces, and guessing between them would be a derivation
    // that lies. A scanner that filled only `components` therefore derives
    // nothing, which is the safe direction: `requiresExplicitConsent` reads an
    // empty list as dangerous, so such a capability is gated rather than waved
    // through. Pinned because the quiet failure would be the opposite.
    const componentsOnly = { components: { hook: ["h.sh"], mcp: ["srv"] } };
    expect(deriveExecutionSurfaces(componentsOnly)).toEqual([]);
    expect(requiresExplicitConsent(deriveExecutionSurfaces(componentsOnly))).toBe(true);
  });

  it("output order is canonical, so equal sets compare equal", () => {
    const a = deriveExecutionSurfaces({ mcp: [{ command: "c" }], bin: ["b"] });
    const b = deriveExecutionSurfaces({ bin: ["b"], mcp: [{ command: "c" }] });
    expect(a).toEqual(b);
    expect(a).toEqual(["ships_bin", "mcp_stdio_command"]);
  });

  it("one server declaring both a command and a url reports both", () => {
    expect(deriveExecutionSurfaces({ mcp: [{ command: "node s.js", url: "https://x/mcp" }] }))
      .toEqual(["mcp_stdio_command", "mcp_remote_url"]);
  });
});
