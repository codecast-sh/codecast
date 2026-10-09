import { test, expect, describe, mock } from "bun:test";

// A plain anchor for next/link, as lib/remarkEntityIds.test.tsx does. No
// convex/react mock: an object pill reads the store alone, and bun shares
// module mocks across the files of one run, so a second, different mock of
// convex/react would break that file's doc lookups.
mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

const { JSDOM } = await import("jsdom");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { replaceGlobals } = await import("../../test-helpers/globals");
const { MemoryRouter } = await import("react-router");
const { default: ReactMarkdown } = await import("react-markdown");
const { entityRemarkPlugins } = await import("../remarkEntityIds");
const { EntityAwareLink, EntityAwareCode } = await import("../../components/EntityIdPill");
const { useInboxStore } = await import("../../store/inboxStore");
const { isObjectRef, objectKinds } = await import("./objects");

(globalThis as any).__inboxStore = useInboxStore;

function seed(objects: Record<string, any>) {
  useInboxStore.setState({
    mods: {
      m1: { _id: "m1", name: "bug-desk", title: "Bug Desk", manifest: { name: "bug-desk", objects: [{ prefix: "bug", title: "Bug", icon: "bug", statuses: ["open", "fixed"] }] } },
    },
    modObjects: objects,
  } as any);
}

/** A client render, so the pill reads the seeded store rather than the server snapshot. */
async function render(markdown: string): Promise<string> {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://codecast.test/inbox" });
  const restore = replaceGlobals({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    await act(() => root.render(
      <MemoryRouter>
        <ReactMarkdown remarkPlugins={entityRemarkPlugins} components={{ a: EntityAwareLink, code: EntityAwareCode } as any}>
          {markdown}
        </ReactMarkdown>
      </MemoryRouter>,
    ));
    return container.innerHTML;
  } finally {
    await act(() => root.unmount());
    restore();
  }
}

describe("mod object references in prose", () => {
  test("a declared kind's short id is a pill titled from the store; look-alike prose stays text", async () => {
    seed({ o1: { _id: "o1", short_id: "bug-14", prefix: "bug", title: "Pane flashes on reload", status: "open", updated_at: 2 } });
    expect(objectKinds().has("bug")).toBe(true);
    expect(isObjectRef("BUG-14")).toBe(true);
    expect(isObjectRef("covid-19")).toBe(false);
    const html = await render("Filed bug-14 after the covid-19 rush, see also top-10.");
    expect(html).toContain('href="/o/bug-14"');
    expect(html).toContain("Pane flashes on reload");
    expect(html).toContain("covid-19");
    expect(html).toContain("top-10");
    expect(html).not.toContain('href="/o/covid-19"');
  });

  test("an object not in the store yet pills with its short id, and a done one dims", async () => {
    seed({ o2: { _id: "o2", short_id: "bug-3", prefix: "bug", title: "Fixed thing", status: "fixed", updated_at: 1 } });
    const unknown = await render("what about bug-99?");
    expect(unknown).toContain('href="/o/bug-99"');
    expect(unknown).toContain(">bug-99<");
    const done = await render("bug-3 is done");
    expect(done).toContain("opacity-60");
  });

  test("ids inside inline code are left alone", async () => {
    seed({});
    expect(await render("run `cast obj show bug-14`")).not.toContain('href="/o/bug-14"');
  });
});

describe("a mod pane link alone on a line", () => {
  test("renders the live pane embed; the same link inside a sentence stays a link", async () => {
    seed({});
    const alone = await render("Here it is:\n\nhttps://codecast.sh/m/bug-desk/triage\n\nTell me what to change.");
    expect(alone).toContain('data-mod-embed="bug-desk"');
    expect(alone).toContain("Bug Desk");
    const inline = await render("Open https://codecast.sh/m/bug-desk/triage when you have a minute.");
    expect(inline).not.toContain("data-mod-embed");
    expect(inline).toContain('href="/m/bug-desk/triage"');
  });
});

