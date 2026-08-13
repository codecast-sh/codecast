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
  formatCapabilitySlug,
  isCapabilityKind,
  isCapabilitySource,
  isExecutionSurface,
  isMaterializableKind,
  isObservedScope,
  isScopeKind,
  isWellFormedCapabilitySlug,
  parseCapabilitySlug,
  parseAnyCapabilitySlug,
  requiresExplicitConsent,
  scopePrecedence,
  slugMatchesSource,
  type CapabilityKind,
  type ScopeKind,
} from "./capabilities";

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
      const slug = formatCapabilitySlug({ source, segments: ["x"] });
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

describe("kinds a driver may write", () => {
  it("is a subset of the kinds", () => {
    for (const k of MATERIALIZABLE_KINDS) {
      expect((CAPABILITY_KINDS as readonly CapabilityKind[]).includes(k)).toBe(true);
    }
  });
});
