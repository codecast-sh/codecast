import { describe, expect, mock, test } from "bun:test";

// Agents name a deploy by the GitHub Actions run that carries it ("Deploy
// 44822506482"). The whole path runs for real (markdown, remark plugin,
// EntityAwareLink, EntityIdPill) with only the Convex transport faked: the
// number renders as that deploy's pill once codecast says the run carried
// one, and as the words written otherwise, since most runs are CI.

const DEPLOY_RUN_ID = "44822506482";
const FAKE_DEPLOY = {
  _id: "ux72qtvpbmmrmwcjqmhzawejsx8bq9gm",
  short_id: "dp-12",
  target: "web",
  status: "running",
  sha: "2a6e4120abcdef0123456789abcdef0123456789",
  url: `https://github.com/acme/app/actions/runs/${DEPLOY_RUN_ID}`,
  created_at: Date.now() - 12 * 60_000,
  carries: [],
};

const { getFunctionName } = await import("convex/server");

function fakeQuery(fn: unknown, args: any) {
  if (args === "skip") return undefined;
  if (getFunctionName(fn as any) === "deploys:get") return args?.ref === DEPLOY_RUN_ID || args?.ref === "dp-12" ? FAKE_DEPLOY : null;
  return undefined;
}

// Keep every other export real (a missing one is a link-time error), the same shape the references test mocks.
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useQuery: fakeQuery,
  useQueries: () => ({}),
  useMutation: () => async () => undefined,
}));
const noThrow = await import("../hooks/useQueryNoThrow");
mock.module("../hooks/useQueryNoThrow", () => ({
  ...noThrow,
  useQueryNoThrow: (fn: unknown, args: any) => ({ data: fakeQuery(fn, args) }),
}));
mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

const { renderToStaticMarkup } = await import("react-dom/server");
const { MemoryRouter } = await import("react-router");
const { default: ReactMarkdown } = await import("react-markdown");
const { entityRemarkPlugins } = await import("../lib/remarkEntityIds");
const { EntityAwareLink, EntityAwareCode } = await import("./EntityIdPill");

const MD_COMPONENTS = { a: EntityAwareLink, code: EntityAwareCode } as const;

function render(markdown: string): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ReactMarkdown remarkPlugins={entityRemarkPlugins} components={MD_COMPONENTS as any}>
        {markdown}
      </ReactMarkdown>
    </MemoryRouter>,
  );
}

describe("a GitHub Actions run named by its bare id", () => {
  test("a run that carried a deploy reads as the deploy, the word in front kept as prose", () => {
    const html = render(`Deploy ${DEPLOY_RUN_ID} is going out.`);
    expect(html).toMatch(/^<p>Deploy <span class="whitespace-nowrap">|^<p>Deploy <a /);
    expect(html).toContain('<span class="self-baseline">web 2a6e412</span>');
    expect(html).toContain('href="/deploys?deploy=dp-12"');
    expect(html).toContain("deploying 12m");
    expect(html).not.toContain(DEPLOY_RUN_ID);
  });

  test("a run that carried none stays exactly the text written, with no link", () => {
    for (const md of ["CI run 44822599999 passed.", "deploy run #44822599999 is CI.", "(run 44825521157)"]) {
      const html = render(md);
      expect(html).not.toContain("<a ");
      expect(html.replace(/<\/?p>/g, "")).toBe(md);
    }
  });

  test("a shorter number, or one after another word, is never a run", () => {
    for (const md of ["Deploy 12345678 is a count.", "Order 44822506482 shipped."]) {
      const html = render(md);
      expect(html).not.toContain("<a ");
      expect(html).toBe(`<p>${md}</p>`);
    }
  });
});
