import { test, expect, describe, mock } from "bun:test";

// ct-98182: an agent edited a file, then named it in a reply ("copied from the
// edited constitution.md"). The person could not open it from that name: it
// rendered as plain text, so they asked the agent three times and searched the
// page for text the session's diff panel already held.
//
// This drives the real path a reply takes: the conversation's file-path
// context built from its own tool calls (useToolResultMaps), and the assistant
// message body rendered through MessageMarkdown. Only the Convex transport and
// next/link are faked.

const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useMutation: () => async () => undefined,
}));
const noThrow = await import("../../hooks/useQueryNoThrow");
mock.module("../../hooks/useQueryNoThrow", () => ({
  ...noThrow,
  useQueryNoThrow: () => ({ data: undefined }),
}));
mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

const { renderToStaticMarkup } = await import("react-dom/server");
const { MemoryRouter } = await import("react-router");
const { FilePathContext } = await import("../../lib/filePathLinks");
const { useToolResultMaps } = await import("../../hooks/useToolResultMaps");
const { MessageMarkdown } = await import("./markdown");

const CWD = "/Users/samvit/src/codecast";
const EDITED = `${CWD}/docs/prompts/constitution.md`;

// A session that edited constitution.md, then described it in a reply.
const conversation = {
  _id: "conv1",
  project_path: CWD,
  git_root: CWD,
  messages: [
    { _id: "m1", role: "user", content: "tighten the constitution prompt", timestamp: 1 },
    {
      _id: "m2",
      role: "assistant",
      timestamp: 2,
      tool_calls: [
        {
          id: "tu1",
          name: "Edit",
          input: JSON.stringify({ file_path: EDITED, old_string: "Be brief.", new_string: "Be brief and exact." }),
        },
      ],
    },
    { _id: "m3", role: "assistant", timestamp: 3, tool_results: [{ tool_use_id: "tu1", content: "ok" }] },
  ],
} as any;

function Reply({ text }: { text: string }) {
  const { filePathCtx } = useToolResultMaps({ conversation, codeRepository: null });
  return (
    <FilePathContext.Provider value={filePathCtx}>
      <MessageMarkdown content={text} />
    </FilePathContext.Provider>
  );
}

function render(text: string): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <Reply text={text} />
    </MemoryRouter>,
  );
}

// Every <a> whose visible text is `name`, with its href.
function linksNamed(html: string, name: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    const text = m[2].replace(/<[^>]+>/g, "").trim();
    if (text === name) out.push(m[1]);
  }
  return out;
}

describe("a reply that names a file the session edited", () => {
  test("the pipeline links a path written with its directory (control: works today)", () => {
    const html = render("This is the exact text, copied from the edited docs/prompts/constitution.md.");
    const links = linksNamed(html, "docs/prompts/constitution.md");
    expect(links.length).toBe(1);
  });

  test("a bare file name of the edited file opens that file", () => {
    const html = render("Sorry for the runaround. This is the exact text the replays are testing, copied from the edited constitution.md.");
    const links = linksNamed(html, "constitution.md");
    expect(links.length).toBe(1);
    expect(decodeURIComponent(links[0].replace(/&amp;/g, "&"))).toContain("constitution.md");
  });

  test("a bare name the session never touched stays plain text", () => {
    const html = render("I left notes.md alone.");
    expect(linksNamed(html, "notes.md")).toEqual([]);
  });
});
