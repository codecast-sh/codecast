import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseDecideOption, pickDecisionTarget, looksLikeDecisionId, describeResolution, formatDecisionList, formatAge, isStaleDecision, parseAnswerSpec, parseDecideSpec, parseOptionBodyArg, parseOptionPageArg, pageRefToSlug, attachOptionPages, type DecideOption, type DecisionRow } from "./decideCommand.js";

describe("cast decide option parsing", () => {
  it("keeps a bare label as a label", () => {
    expect(parseDecideOption("Approve")).toEqual({ label: "Approve" });
  });

  it("splits 'label :: what happens' into label and consequence", () => {
    expect(parseDecideOption("Approve :: frees the last migration")).toEqual({
      label: "Approve",
      description: "frees the last migration",
    });
  });

  it("tolerates missing spaces around the separator", () => {
    expect(parseDecideOption("Path wins::stable across edits")).toEqual({
      label: "Path wins",
      description: "stable across edits",
    });
  });

  it("ignores a trailing separator with no consequence after it", () => {
    expect(parseDecideOption("Hold ::")).toEqual({ label: "Hold" });
  });

  it("only splits on the FIRST separator, so a consequence may contain one", () => {
    expect(parseDecideOption("Ship :: a :: b")).toEqual({
      label: "Ship",
      description: "a :: b",
    });
  });
});

const row = (over: Partial<DecisionRow>): DecisionRow => ({
  id: "k57abcdefghijklmnopqrstuv",
  question: "Which schema wins?",
  options: [{ label: "Frontmatter" }, { label: "Path", description: "stable across edits" }],
  blocking: true,
  status: "pending",
  created_at: 1,
  ...over,
});

describe("cast decide edit/cancel target", () => {
  it("an explicit id always wins", () => {
    expect(pickDecisionTarget([], "k57abcdefghijklmnopqrstuv")).toEqual({ id: "k57abcdefghijklmnopqrstuv" });
  });

  it("acts on the session's one open decision when no id is given", () => {
    const rows = [row({ id: "aaaaaaaaaaaaaaaaaaaaaaaa", status: "answered", answer_index: 1 }), row({})];
    expect(pickDecisionTarget(rows)).toEqual({ id: "k57abcdefghijklmnopqrstuv" });
  });

  it("refuses to guess between several open decisions and lists them", () => {
    const rows = [row({ id: "aaaaaaaaaaaaaaaaaaaaaaaa", question: "A?" }), row({ id: "bbbbbbbbbbbbbbbbbbbbbbbb", question: "B?" })];
    const out = pickDecisionTarget(rows);
    expect("error" in out).toBe(true);
    expect((out as any).error).toContain("2 open decisions");
    expect((out as any).error).toContain("aaaaaaaaaaaaaaaaaaaaaaaa  A?");
  });

  it("explains how the latest decision was resolved when none is open", () => {
    const rows = [row({ status: "answered", answer_index: 1 })];
    expect((pickDecisionTarget(rows) as any).error).toContain("answered: Path");
  });

  it("points at posting one when the session never asked", () => {
    expect((pickDecisionTarget([]) as any).error).toContain("Post one with");
  });
});

describe("cast decide id shape", () => {
  it("accepts a Convex id and rejects prose or a subcommand word", () => {
    expect(looksLikeDecisionId("k57abcdefghijklmnopqrstuv")).toBe(true);
    expect(looksLikeDecisionId("edit")).toBe(false);
    expect(looksLikeDecisionId("Which schema wins?")).toBe(false);
    expect(looksLikeDecisionId(undefined)).toBe(false);
  });
});

describe("cast decide ls formatting", () => {
  it("names the answer label, marks the chosen option, and flags advisory", () => {
    const text = formatDecisionList([
      row({ status: "answered", answer_index: 1, blocking: false, default_option: 0 }),
    ]);
    expect(text).toContain("answered: Path  (advisory)");
    expect(text).toContain("✓ 2. Path — stable across edits");
    expect(text).not.toContain("→ 1.");
  });

  it("marks the default of an open advisory decision", () => {
    const now = 1 + 5 * 60_000;
    const text = formatDecisionList([row({ blocking: false, default_option: 0 })], now);
    expect(text).toContain("→ 1. Frontmatter");
    expect(text).toContain("still open — asked 5m ago  (advisory)");
  });

  it("describes a free-text answer and a withdrawal", () => {
    expect(describeResolution(row({ status: "answered", answer_text: "neither, merge them" }))).toBe("answered: neither, merge them");
    expect(describeResolution(row({ status: "withdrawn" }))).toBe("withdrawn");
  });

  it("shows how far the session has run past an open ask", () => {
    const now = 1 + 30 * 60_000;
    const text = formatDecisionList([row({ messages_since: 12 })], now);
    expect(text).toContain("still open — asked 30m ago, 12 messages since");
    expect(text).not.toContain("moved past");
  });

  it("nudges cleanup when an open ask has gone stale, and only then", () => {
    const now = 1 + 3 * 60 * 60_000;
    const stale = formatDecisionList([row({})], now);
    expect(stale).toContain("cast decide cancel <id>");

    const fresh = formatDecisionList([row({})], 1 + 10 * 60_000);
    expect(fresh).not.toContain("cast decide cancel <id>");

    // A resolved row never counts as stale, however old.
    const resolved = formatDecisionList([row({ status: "withdrawn" })], now);
    expect(resolved).not.toContain("cast decide cancel <id>");
  });
});

describe("decision staleness", () => {
  it("goes stale on age or on conversation drift, pending rows only", () => {
    expect(isStaleDecision(row({}), 1 + 60_000)).toBe(false);
    expect(isStaleDecision(row({}), 1 + 3 * 60 * 60_000)).toBe(true);
    expect(isStaleDecision(row({ messages_since: 40 }), 1 + 60_000)).toBe(true);
    expect(isStaleDecision(row({ status: "answered", messages_since: 40 }), 1 + 3 * 60 * 60_000)).toBe(false);
  });

  it("formats ages coarsely", () => {
    expect(formatAge(20_000)).toBe("just now");
    expect(formatAge(5 * 60_000)).toBe("5m ago");
    expect(formatAge(3 * 60 * 60_000)).toBe("3h ago");
    expect(formatAge(50 * 60 * 60_000)).toBe("2d ago");
  });
});

describe("cast decide answer parsing (W2)", () => {
  const isId = looksLikeDecisionId;
  it("single takes one 1-based number and rejects lists", () => {
    expect(parseAnswerSpec("single", "2", [], 3)).toEqual({ answer_index: 1 });
    expect(() => parseAnswerSpec("single", "1,2", [], 3)).toThrow(/one option/);
    expect(() => parseAnswerSpec("single", "4", [], 3)).toThrow(/not an option/);
  });
  it("multi takes a comma list, rank an ordered list, form key=value pairs", () => {
    expect(parseAnswerSpec("multi", "1,3", [], 3)).toEqual({ answer_json: [0, 2], answer_index: 0 });
    expect(parseAnswerSpec("rank", "2>1>3", [], 3)).toEqual({ answer_json: [1, 0, 2], answer_index: 1 });
    expect(() => parseAnswerSpec("rank", "2", [], 3)).toThrow(/at least two/);
    const fields = [
      { key: "env", label: "Env", type: "select" as const, options: ["dev", "prod"] },
      { key: "n", label: "N", type: "number" as const },
      { key: "ok", label: "Ok", type: "bool" as const },
      { key: "note", label: "Note", type: "text" as const },
    ];
    expect(parseAnswerSpec("form", undefined, ["env=prod", "n=3", "ok=true", "note=42"], undefined, fields)).toEqual({
      answer_json: { env: "prod", n: 3, ok: true, note: "42" },
    });
    expect(() => parseAnswerSpec("form", undefined, ["n=lots"], undefined, fields)).toThrow(/must be a number/);
    expect(() => parseAnswerSpec("form", undefined, ["ok=yes"], undefined, fields)).toThrow(/true or false/);
    expect(() => parseAnswerSpec("form", undefined, [])).toThrow(/--form/);
  });
  it("sd-N short ids count as decision ids", () => {
    expect(isId("sd-12")).toBe(true);
    expect(isId("edit")).toBe(false);
  });
  it("a spec parses string options and validates kind and form", () => {
    const spec = parseDecideSpec(JSON.stringify({ question: "Q", kind: "multi", options: ["A :: a", { label: "B", cost: "1d" }] }));
    expect(spec.options).toEqual([{ label: "A", description: "a" }, { label: "B", cost: "1d" }]);
    expect(() => parseDecideSpec(JSON.stringify({ kind: "weird" }))).toThrow(/kind/);
    expect(() => parseDecideSpec(JSON.stringify({ form: { fields: [] } }))).toThrow(/form.fields/);
    expect(() => parseDecideSpec("not json")).toThrow(/JSON/);
  });
  it("--option-body takes n=file", () => {
    expect(parseOptionBodyArg("2=why.md")).toEqual({ index: 1, file: "why.md" });
    expect(() => parseOptionBodyArg("why.md")).toThrow(/n=file/);
  });
});

// Option pages (the-line.md L6): `--option-page n=file|slug|url` and `page`
// on a spec option. A file publishes through the report path, once per
// option; an existing slug or url attaches as its slug.
describe("cast decide option pages (the-line.md L6)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decide-pages-"));
  const fileA = path.join(dir, "mockup-a.html");
  fs.writeFileSync(fileA, "<h1>A</h1>");

  it("--option-page takes n=file, like --option-body", () => {
    expect(parseOptionPageArg("2=mockup-b.html")).toEqual({ index: 1, file: "mockup-b.html" });
    expect(() => parseOptionPageArg("mockup.html")).toThrow(/--option-page expects n=file/);
  });

  it("a codecast page url or a bare slug is an existing page; a file on disk is not", () => {
    expect(pageRefToSlug("https://codecast.sh/a/abc123xyz")).toBe("abc123xyz");
    expect(pageRefToSlug("https://codecast.sh/a/abc123xyz?v=2")).toBe("abc123xyz");
    expect(pageRefToSlug("abc123xyz")).toBe("abc123xyz");
    expect(pageRefToSlug("mockup-b.html")).toBeNull();
    expect(pageRefToSlug(fileA)).toBeNull();
  });

  it("publishes a file once per option through the given publish path, keeps a slug ref, and strips spec `page`", async () => {
    const published: string[] = [];
    const publish = async (file: string) => {
      published.push(file);
      return { slug: `slug-${published.length}`, url: `https://codecast.sh/a/slug-${published.length}` };
    };
    const optionList: DecideOption[] = [{ label: "A" }, { label: "B", page: "https://codecast.sh/a/existing1" }, { label: "C" }];
    const urls = await attachOptionPages(optionList, [`1=${fileA}`], publish);
    expect(published).toEqual([fileA]);
    expect(optionList[0]).toEqual({ label: "A", page_slug: "slug-1" });
    expect(optionList[1]).toEqual({ label: "B", page_slug: "existing1" });
    expect(optionList[2]).toEqual({ label: "C" });
    expect(urls).toEqual({ 0: "https://codecast.sh/a/slug-1" });
    // The wire shape carries page_slug only: no `page`, no `page_url`.
    for (const o of optionList) expect(Object.keys(o).every((k) => k !== "page" && k !== "page_url")).toBe(true);
  });

  it("a flag names the option by number and refuses one that does not exist or a file that is missing", async () => {
    const publish = async () => ({ slug: "x", url: "u" });
    await expect(attachOptionPages([{ label: "A" }, { label: "B" }], ["3=" + fileA], publish)).rejects.toThrow(/no option 3/);
    await expect(attachOptionPages([{ label: "A" }, { label: "B" }], ["1=" + path.join(dir, "missing.html")], publish)).rejects.toThrow(/no such file or page/);
  });

  it("a flag wins over the spec's page for the same option", async () => {
    const publish = async (file: string) => ({ slug: "fromfile", url: `u:${file}` });
    const optionList: DecideOption[] = [{ label: "A", page: "specslug1" }, { label: "B" }];
    await attachOptionPages(optionList, [`1=${fileA}`], publish);
    expect(optionList[0].page_slug).toBe("fromfile");
  });

  it("ls prints an option's page url, and --mine has its own empty line", () => {
    const out = formatDecisionList([row({ options: [{ label: "A", page_slug: "s1", page_url: "https://codecast.sh/a/s1" }, { label: "B" }] })], 1);
    expect(out).toContain("1. A");
    expect(out).toContain("page: https://codecast.sh/a/s1");
    expect(out.split("page:").length).toBe(2);
    expect(formatDecisionList([], 1, "No pending decisions held by you.")).toBe("No pending decisions held by you.");
  });

  it("a spec option may carry page", () => {
    const spec = parseDecideSpec(JSON.stringify({ options: [{ label: "A", page: "mockup-a.html" }, "B"] }));
    expect(spec.options?.[0].page).toBe("mockup-a.html");
  });
});

// The wire for `cast decide ls --mine` (the-line.md L10): the flag rides to
// /cli/decide as `mine: true`. The transport is faked (globalThis.fetch), so
// the real decideApi shapes the request.
describe("cast decide ls --mine on the wire", () => {
  const SITE = "https://x.test";
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  let logs: string[] = [];
  const deps = { getCliEndpoint: () => ({ siteUrl: SITE, apiToken: "t" }), detectCurrentSessionId: () => "s1" } as any;

  beforeEach(() => {
    calls.length = 0;
    logs = [];
    globalThis.fetch = (async (url: string | URL | Request, init: RequestInit) => {
      const path = String(url).slice(SITE.length);
      const { api_token: _token, ...body } = JSON.parse(String(init.body));
      calls.push({ path, body });
      return new Response(JSON.stringify({ decisions: [] }), { status: 200 });
    }) as typeof fetch;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    console.log = realLog;
  });

  async function run(...argv: string[]) {
    const { Command } = await import("commander");
    const { registerDecideCommand } = await import("./decideCommand.js");
    const program = new Command();
    program.exitOverride();
    registerDecideCommand(program, deps);
    await program.parseAsync(["node", "cast", "decide", ...argv]);
  }

  it("posts mine: true and prints the empty line for decisions held by you", async () => {
    await run("ls", "--mine");
    expect(calls).toEqual([{ path: "/cli/decide", body: { action: "ls", session_id: "s1", mine: true } }]);
    expect(logs.join("\n")).toContain("No pending decisions held by you.");
    calls.length = 0;
    await run("ls");
    expect(calls[0].body).toEqual({ action: "ls", session_id: "s1" });
  });
});

// A person at a plain shell answers with no session (decisions-as-documents.md
// D2). The request must omit session_id rather than send null: the route's
// validator takes a string or nothing, and null parked every terminal answer.
describe("cast decide answer from a plain shell on the wire", () => {
  const SITE = "https://x.test";
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const deps = { getCliEndpoint: () => ({ siteUrl: SITE, apiToken: "t" }), detectCurrentSessionId: () => null } as any;

  beforeEach(() => {
    calls.length = 0;
    globalThis.fetch = (async (url: string | URL | Request, init: RequestInit) => {
      const path = String(url).slice(SITE.length);
      const { api_token: _token, ...body } = JSON.parse(String(init.body));
      calls.push({ path, body });
      if (path === "/cli/decide/show") {
        return new Response(JSON.stringify({ decision: { short_id: "sd-1", kind: "single", options: [{ label: "A" }, { label: "B" }], status: "pending" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, short_id: "sd-1", answer_label: "A", answered_by: { kind: "user", id: "u1" } }), { status: 200 });
    }) as typeof fetch;
    console.log = () => {};
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    console.log = realLog;
  });

  it("omits session_id when no session is detected", async () => {
    const { Command } = await import("commander");
    const { registerDecideCommand } = await import("./decideCommand.js");
    const program = new Command();
    program.exitOverride();
    registerDecideCommand(program, deps);
    await program.parseAsync(["node", "cast", "decide", "answer", "sd-1", "1"]);
    const answer = calls.find((c) => c.path === "/cli/decide/answer");
    expect(answer).toBeDefined();
    expect("session_id" in answer!.body).toBe(false);
    expect(answer!.body.answer_index).toBe(0);
  });
});
