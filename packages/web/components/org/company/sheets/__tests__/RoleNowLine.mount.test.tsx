// ct-97956: a role's current-work line names the work it is on. The words
// must open that work when clicked, not sit as a plain span beside the one
// small session pill that does.
// Run: bun test components/org/company/sheets/__tests__/RoleNowLine.mount.test.tsx
import { test, expect, afterAll, mock } from "bun:test";
import { closeDomWindow } from "../../../../../test-helpers/domGlobals";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLAnchorElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage"]) {
  const v = (dom.window as any)[key];
  if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => closeDomWindow(dom));

const React = await import("react");
const h = React.createElement;
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => h("a", { href, ...rest }, children) }));
mock.module("next/navigation", () => ({ useRouter: () => ({ push() {}, replace() {} }), useSearchParams: () => new URLSearchParams(), usePathname: () => "/" }));
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}), useMutation: () => async () => {} }));
const noThrow = await import("../../../../../hooks/useQueryNoThrow");
mock.module("../../../../../hooks/useQueryNoThrow", () => ({ ...noThrow, useQueryNoThrow: () => ({ data: undefined, error: undefined, retry: () => {} }) }));
const realOpen = { ...(await import("../../../../../hooks/useOpenLinkedSession")) };
const opened: string[] = [];
mock.module("../../../../../hooks/useOpenLinkedSession", () => ({ ...realOpen, useOpenLinkedSession: () => (conv: any) => { opened.push(conv._id); } }));

const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { RoleNowLine } = await import("../sheetParts");
type OrgRole = import("../../../orgTypes").OrgRole;

const WORDS = "Fixing a live leak: the broker's new sharing wording can pass a person's health on in an introduction";
const role = {
  _id: "role-1", short_id: "r-1", name: "Broker steward", handle: "broker", status: "active",
  scope_type: "team", team_id: "team-1", host_user_id: "u1", scope: { kind: "team" }, reports_to: { kind: "user", user_id: "u1" },
  standing: { state_line: WORDS, state_at: Date.now() - 60_000 },
  sessions: [{ _id: "sess-1", short_id: "jx7abcd", title: "broker leak", agent_type: "claude_code", state: "working", updated_at: Date.now(), subagent_count: 0, is_anchor: true }],
  counts: {}, total: 1,
} as unknown as OrgRole;

async function mount(r: OrgRole, onOpen?: () => void) {
  opened.length = 0;
  const root = createRoot(document.getElementById("root")!);
  await act(async () => { root.render(h(RoleNowLine, { role: r, onOpen })); });
  const words = document.querySelector("[data-role-now-words]") as HTMLElement;
  return { words, unmount: () => act(async () => { root.unmount(); }) };
}
async function click(el: Element) {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

test("the words naming a role's current work open that work", async () => {
  const { words, unmount } = await mount(role);
  expect(words?.textContent).toBe(WORDS);
  // The words themselves are the way in: a link or button, not inert text.
  const opener = words!.closest("a[href], button, [role=button], [role=link]");
  expect(opener, "the current-work words sit in no link or button, so clicking them opens nothing").not.toBeNull();
  await unmount();
});

test("a state line opens the role's standing session, even beside a live one", async () => {
  const { words, unmount } = await mount({ ...role, standing: { ...role.standing, conversation_id: "standing-1", short_id: "jx7stand" } } as OrgRole);
  expect(words.tagName).toBe("BUTTON");
  await click(words);
  expect(opened).toEqual(["standing-1"]);
  await unmount();
});

test("a state line with a standing session and nothing live still opens the standing session", async () => {
  const { words, unmount } = await mount({ ...role, sessions: [], standing: { ...role.standing, conversation_id: "standing-1" } } as OrgRole);
  expect(words.tagName).toBe("BUTTON");
  await click(words);
  expect(opened).toEqual(["standing-1"]);
  await unmount();
});

test("without a state line the words open the working session they summarise", async () => {
  const { words, unmount } = await mount({ ...role, standing: { conversation_id: "standing-1" } } as OrgRole);
  await click(words);
  expect(opened).toEqual(["sess-1"]);
  await unmount();
});

test("words that name no session stay plain text and open nothing", async () => {
  const { words, unmount } = await mount({ ...role, sessions: [] } as OrgRole);
  expect(words.textContent).toBe(WORDS);
  expect(words.closest("a[href], button, [role=button], [role=link]")).toBeNull();
  expect(words.className).not.toContain("hover:underline");
  await click(words);
  expect(opened).toEqual([]);
  await unmount();
});

test("a sheet's onOpen still opens the role from its name", async () => {
  let roleOpened = 0;
  const { unmount } = await mount({ ...role, standing: { ...role.standing, conversation_id: "standing-1" } } as OrgRole, () => { roleOpened++; });
  await click(document.querySelector("[data-role-now-open]")!);
  expect(roleOpened).toBe(1);
  expect(opened).toEqual([]);
  await unmount();
});
