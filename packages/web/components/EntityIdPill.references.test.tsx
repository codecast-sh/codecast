import { test, expect, describe, mock } from "bun:test";

// End-to-end check of the label rule for inline object references: a reference
// reads as the object's NAME, never its id. Here the whole path runs for real —
// markdown → remark plugin → EntityIdPill — with only the Convex transport
// faked, so what these assertions see is the same HTML a reader gets.
//
// The symptom that started this: an agent wrote a trigger's id into its summary
// and the conversation rendered a raw 32-char blob in monospace. Tasks and
// plans had the same problem in a milder form — "ct-38940" mid-sentence tells
// the reader nothing about what is being discussed.

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

const TASK_CONVEX_ID = "kx72qtvpbmmrmwcjqmhzawejsx8bq9gm";
const FAKE_TASK = {
  _id: TASK_CONVEX_ID,
  short_id: "ct-38940",
  title: "Retry queue for failed webhooks",
  status: "in_progress",
  priority: "high",
};

const PLAN_CONVEX_ID = "mx72qtvpbmmrmwcjqmhzawejsx8bq9gm";
const FAKE_PLAN = {
  _id: PLAN_CONVEX_ID,
  short_id: "pl-88",
  title: "Billing migration",
  status: "active",
  goal: "Move every customer onto the new Stripe webhook API.",
  tasks: [],
};

// A title long enough to prove the pill truncates rather than swallowing the
// sentence around it.
const LONG_TITLE_TASK = {
  _id: "nx72qtvpbmmrmwcjqmhzawejsx8bq9gm",
  short_id: "ct-77",
  title: "Rewrite the delivery pipeline so queued sends survive a daemon restart",
  status: "open",
};

// Every `webGet` is asked by `{ short_id }` or `{ id }`, so the fake transport
// dispatches on the function's NAME. (`api` is a proxy — each property access
// hands back a fresh object, so `===` on it never matches.)
const { getFunctionName } = await import("convex/server");

const ROWS: Record<string, any[]> = {
  "agentTasks:webGet": [FAKE_TRIGGER],
  "tasks:webGet": [FAKE_TASK, LONG_TITLE_TASK],
  "plans:webGet": [FAKE_PLAN],
};

const TYPE_OF_CONVEX_ID: Record<string, string> = {
  [TRIGGER_CONVEX_ID]: "trigger",
  [TASK_CONVEX_ID]: "task",
  [PLAN_CONVEX_ID]: "plan",
};

// A published page (`cast publish` output) the fake server knows about.
const PAGE_SLUG = "Ab3xYz9Qw12k";
const FAKE_PAGE = {
  slug: PAGE_SLUG,
  title: "Q3 growth report",
  size: 4096,
  version: 3,
  kind: "html",
  gated: false,
  user: { name: "Ashot", image: null },
};

function fakeQuery(fn: unknown, args: any) {
  if (args === "skip") return undefined;
  const name = getFunctionName(fn as any);
  if (name === "entities:resolveIdType") return TYPE_OF_CONVEX_ID[args?.id] ?? null;
  if (name === "artifacts:getShared") return args?.slug === PAGE_SLUG ? FAKE_PAGE : null;
  const rows = ROWS[name];
  if (!rows) return undefined;
  return rows.find((r) => r.short_id === args?.short_id || r._id === args?.id) ?? null;
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

// A task the CLIENT knows about but this fake server never answers for — the
// local-first seed. `ct-50001` is absent from ROWS above on purpose.
const SEEDED_TASK = {
  _id: "px72qtvpbmmrmwcjqmhzawejsx8bq9gm",
  short_id: "ct-50001",
  title: "Seeded from the local store",
  status: "open",
};
// Seed the REAL store rather than mock.module-ing it: bun's module mocks are
// process-global and never restored, so a getState-only stub here (no
// setState) poisons every store suite that loads after this file in a full
// `bun test` run. The pill reads via getState(), so a real seeded row behaves
// identically.
const { useInboxStore } = await import("../store/inboxStore");
useInboxStore.setState({ tasks: { [SEEDED_TASK._id]: SEEDED_TASK } } as any);

const { renderToStaticMarkup } = await import("react-dom/server");
const { MemoryRouter } = await import("react-router");
const { default: ReactMarkdown } = await import("react-markdown");
const { entityRemarkPlugins } = await import("../lib/remarkEntityIds");
const { EntityAwareLink, EntityAwareCode } = await import("./EntityIdPill");

const MD_COMPONENTS = { a: EntityAwareLink, code: EntityAwareCode } as const;

// The pill resolves its open gesture via router hooks (useOpenLinkedSession),
// so rendering needs a Router around it — same as every real surface.
function render(markdown: string): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ReactMarkdown remarkPlugins={entityRemarkPlugins} components={MD_COMPONENTS as any}>
        {markdown}
      </ReactMarkdown>
    </MemoryRouter>,
  );
}

// The pill's visible text, with the surrounding markup stripped — what a reader
// actually sees where the id was written.
function pillText(html: string): string {
  const m = html.match(/<a [^>]*class="not-prose[^"]*"[^>]*>.*?<span>([^<]*)<\/span><\/a>/);
  return m ? m[1] : "";
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

  test("a Convex-shaped id that resolves to no entity table stays inline code", () => {
    // Message ids, hashes, and ids whose resolveIdType is still in flight all
    // reach the pill with type === null; it must fall back, not throw on the
    // missing task glyph (prod: "Cannot read properties of null (reading 'icon')").
    const unknown = "zz72qtvpbmmrmwcjqmhzawejsx8bq9gm";
    const html = render(`See \`${unknown}\` for details.`);
    expect(html).toMatch(new RegExp(`<code[^>]*>${unknown}<\/code>`));
  });
});

describe("inline task and plan references", () => {
  // The reported symptom: "…ticks (ct-38940)." told the reader nothing. A task
  // reference is a name now, exactly like a session or trigger reference.
  test("a task short id renders the task's title, not the id", () => {
    const html = render("Ticks up on ct-38940 now.");
    expect(pillText(html)).toBe("Retry queue for failed webhooks");
    expect(html).not.toContain(">ct-38940<");
    expect(html).toContain('href="/tasks/' + TASK_CONVEX_ID + '"');
  });

  test("a plan short id renders the plan's title", () => {
    const html = render("Rolled into pl-88 this week.");
    expect(pillText(html)).toBe("Billing migration");
    expect(html).not.toContain(">pl-88<");
  });

  test("a task id in backticks becomes a titled reference too", () => {
    const html = render("Filed `ct-38940` for the retry queue.");
    expect(pillText(html)).toBe("Retry queue for failed webhooks");
    expect(html).not.toContain("<code>ct-38940</code>");
  });

  test("an @[Title id] task mention resolves to the live title", () => {
    // The written title is stale on purpose: the pill shows what the task is
    // called NOW, not what it was called when the agent typed the mention.
    const html = render("see @[Old name ct-38940] for the retry work");
    expect(pillText(html)).toBe("Retry queue for failed webhooks");
    expect(html).not.toContain("Old name");
  });

  test("a long title is clipped on a word boundary, not mid-word", () => {
    const html = render("Blocked on ct-77 until the restart lands.");
    const label = pillText(html);
    expect(label).toBe("Rewrite the delivery pipeline so queued…");
    expect(html).toContain("until the restart lands.");
  });

  test("a task nobody can read keeps its short id", () => {
    // webGet returns null for a task outside the reader's workspace. The pill
    // must not go blank or claim a title it never got — it falls back to the id.
    const html = render("Ask them about ct-99999.");
    expect(html).toContain("ct-99999");
  });
});

describe("published page links", () => {
  const PAGE_URL = `https://codecast.sh/a/${PAGE_SLUG}`;

  test("a publish URL alone on its line embeds the live page", () => {
    const html = render(`Here is the report:\n\n${PAGE_URL}\n\nTell me what to change.`);
    expect(html).toContain("<iframe");
    expect(html).toContain(`/cli/a/${PAGE_SLUG}`);
    // The header carries the page's live title.
    expect(html).toContain("Q3 growth report");
    // The surrounding prose is untouched.
    expect(html).toContain("Tell me what to change.");
  });

  test("[caption](url) on its own line renders the caption under the frame", () => {
    const html = render(`[Funnel by market, last 30 days](${PAGE_URL})`);
    expect(html).toContain("<iframe");
    expect(html).toContain("Funnel by market, last 30 days");
  });

  test("a publish URL inside a sentence renders a titled pill, not a frame", () => {
    const html = render(`The numbers are in ${PAGE_URL} if you want detail.`);
    expect(html).not.toContain("<iframe");
    expect(html).toContain("Q3 growth report");
    expect(html).toContain(`href="${PAGE_URL}"`);
  });

  test("a deleted page degrades to a note with the link, not a framed 404", () => {
    const html = render("https://codecast.sh/a/Gone12345678");
    expect(html).not.toContain("<iframe");
    expect(html).toContain("Published page unavailable");
    expect(html).toContain("https://codecast.sh/a/Gone12345678");
  });

  test("a non-page /a/ lookalike on another host stays an ordinary link", () => {
    const html = render("see https://example.com/a/Ab3xYz9Qw12k for theirs");
    expect(html).not.toContain("<iframe");
    expect(html).toContain('href="https://example.com/a/Ab3xYz9Qw12k"');
  });
});

describe("local-first seeding", () => {
  // Without this, every task mention in a conversation renders "ct-…" first and
  // swaps to the title a round-trip later — a visible flip and reflow on every
  // mount, on a client that already had the answer in memory.
  test("a reference paints its title on the first render, before any server answer", () => {
    const html = render("Picked up ct-50001 this morning.");
    expect(pillText(html)).toBe("Seeded from the local store");
    expect(html).not.toContain(">ct-50001<");
  });

  test("the server row still wins once it lands", () => {
    // ct-38940 is served AND could be seeded; the served row is the fresher of
    // the two, so it is the one that shows.
    const html = render("Ticks up on ct-38940 now.");
    expect(pillText(html)).toBe("Retry queue for failed webhooks");
  });

  test("an id in neither the store nor the server still degrades to the id", () => {
    const html = render("Ask them about ct-99999.");
    expect(html).toContain("ct-99999");
  });
});

describe("ids that resolve to no entity type", () => {
  // A 32-char Convex id belongs to a table only if `entities.resolveIdType`
  // says so. Until it answers — and forever, for a message id or a random hash
  // — the pill has NO type, and the whole component has to survive that state:
  // it renders on the way to the guard that degrades it to plain text.
  //
  // The regression: the icon was picked with `taskV!.icon`, and `taskV` is set
  // only for a task. A typeless reference took that branch and threw
  // "Cannot read properties of null (reading 'icon')", which killed the whole
  // conversation view rather than one pill.
  const UNKNOWN_CONVEX_ID = "zx72qtvpbmmrmwcjqmhzawejsx8bq9gm";

  test("a Convex id belonging to no table degrades to plain text", () => {
    const html = render(`Look at \`${UNKNOWN_CONVEX_ID}\` in the log.`);
    expect(html).toContain(UNKNOWN_CONVEX_ID);
    expect(html).toContain("in the log.");
  });

  test("a typeless id inside a list renders without taking the list down", () => {
    // The reported shape: the reference sat in a markdown bullet, so the throw
    // unmounted the list and the conversation around it.
    const html = render(`- first\n- see ${UNKNOWN_CONVEX_ID}\n- third`);
    expect(html).toContain("first");
    expect(html).toContain("third");
  });
});

describe("pill chrome", () => {
  // The status tint belongs to the disc on a TASK pill and nowhere else — a
  // session or plan glyph takes its colour from the pill chrome instead. This
  // pins that split, because the icon and the tint are now resolved from the
  // same always-defined status vocabulary and it would be easy to leak the
  // task colour onto every type.
  test("a task pill tints its disc with the status colour", () => {
    // ct-38940 is in_progress → the yellow disc.
    const html = render("Ticks up on ct-38940 now.");
    expect(html).toContain("text-sol-yellow");
    expect(html).toContain("bg-sol-violet/10");
  });

  test("a plan pill carries no task status colour", () => {
    const html = render("Rolled into pl-88 this week.");
    expect(html).toContain("bg-sol-cyan/10");
    expect(html).not.toContain("text-sol-yellow");
  });
});
