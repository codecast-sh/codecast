import { test, expect, describe, mock } from "bun:test";

// End-to-end check of the symptom that started this: an agent wrote a trigger's
// id into its summary and the conversation rendered a raw 32-char blob in
// monospace. Here the whole path runs for real — markdown → remark plugin →
// EntityIdPill — with only the Convex transport faked, so what these assertions
// see is the same HTML a reader gets.

const TRIGGER_CONVEX_ID = "rx72qtvpbmmrmwcjqmhzawejsx8bq9gm";
const FAKE_TRIGGER = {
  _id: TRIGGER_CONVEX_ID,
  short_id: "tr-42",
  title: "Audit budget allocation across markets",
  display_title: "Growth audit",
  display_summary: "Checks funded markets and reports anything off.",
  prompt: "Audit budget allocation across markets.",
  schedule_type: "recurring" as const,
  interval_ms: 4 * 60 * 60 * 1000,
  status: "scheduled",
  run_at: Date.now() + 90 * 60 * 1000,
  run_count: 7,
  last_run_at: Date.now() - 19 * 60 * 1000,
};

// Both `resolveIdType` and `agentTasks.webGet` are asked by `{ id }`, so the
// fake transport dispatches on the function's NAME. (`api` is a proxy — each
// property access hands back a fresh object, so `===` on it never matches.)
const { getFunctionName } = await import("convex/server");

function fakeQuery(fn: unknown, args: any) {
  if (args === "skip") return undefined;
  const name = getFunctionName(fn as any);
  if (name === "entities:resolveIdType") return "trigger";
  if (name === "agentTasks:webGet") {
    const wanted = args?.short_id === FAKE_TRIGGER.short_id || args?.id === TRIGGER_CONVEX_ID;
    return wanted ? FAKE_TRIGGER : null;
  }
  return undefined;
}

// Keep every other export real — the component graph imports names statically,
// and a missing one is a link-time error rather than a call-time one.
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useQuery: fakeQuery,
  useQueries: () => ({}),
}));

const noThrow = await import("../hooks/useQueryNoThrow");
mock.module("../hooks/useQueryNoThrow", () => ({
  ...noThrow,
  useQueryNoThrow: (fn: unknown, args: any) => ({ data: fakeQuery(fn, args) }),
}));

mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const { renderToStaticMarkup } = await import("react-dom/server");
const { default: ReactMarkdown } = await import("react-markdown");
const { entityRemarkPlugins } = await import("../lib/remarkEntityIds");
const { EntityAwareLink, EntityAwareCode } = await import("./EntityIdPill");

const MD_COMPONENTS = { a: EntityAwareLink, code: EntityAwareCode } as const;

function render(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={entityRemarkPlugins} components={MD_COMPONENTS as any}>
      {markdown}
    </ReactMarkdown>,
  );
}

describe("inline trigger references", () => {
  test("a bare short id renders the trigger's name, not its id", () => {
    const html = render("Trigger tr-42 marked complete.");
    expect(html).toContain("Growth audit");
    expect(html).toContain('href="/triggers?task=' + TRIGGER_CONVEX_ID + '"');
    // Reads as a sentence, with the reference standing in for the id.
    expect(html).toContain("Trigger ");
    expect(html).toContain("marked complete.");
  });

  test("the same id inside backticks becomes a reference too", () => {
    // This is the exact shape from the report: the agent wrapped the id in
    // inline code, so the fix has to cover the `code` renderer as well.
    const html = render("Trigger `tr-42` marked complete.");
    expect(html).toContain("Growth audit");
    expect(html).not.toContain("<code>tr-42</code>");
  });

  test("an @[Title id] mention resolves to the same reference", () => {
    const html = render("see @[Growth audit tr-42] for the cadence");
    expect(html).toContain("Growth audit");
    expect(html).not.toContain("@Growth audit");
  });

  test("a raw 32-char trigger id still resolves, for prose already written", () => {
    // Old summaries carry the blob. resolveIdType now knows the agent_tasks
    // table, so those become references retroactively instead of staying blobs.
    const html = render(`Trigger \`${TRIGGER_CONVEX_ID}\` marked complete.`);
    expect(html).not.toContain(`<code>${TRIGGER_CONVEX_ID}</code>`);
    expect(html).toContain("Growth audit");
  });

  test("an unresolvable id degrades to plain text rather than crashing", () => {
    const html = render("Trigger `tr-99999` is gone.");
    expect(html).toContain("tr-99999");
  });
});
