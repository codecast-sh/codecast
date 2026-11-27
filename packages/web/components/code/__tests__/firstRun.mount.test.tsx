// The first screens of the editor: an empty group lists the files opened
// lately and the two ways to find another, and stays blank while a deep link
// resolves; quick open offers a typed path the scan does not list.
import { afterEach, expect, test } from "bun:test";
import { installEditorDom, settle } from "./editorDom";

installEditorDom();

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { useVaultStore } = await import("../../../store/vaultStore");
const { EditorGroup } = await import("../workspace/EditorGroup");
const { QuickOpen } = await import("../workspace/QuickOpen");
const { registerCodeCommand } = await import("../../../lib/code/commands");

const roots: { unmount(): void }[] = [];
afterEach(() => act(() => roots.splice(0).forEach((r) => r.unmount())));

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(node);
    await settle();
  });
  return host;
}

useVaultStore.setState({
  activeVaultId: "vault-1",
  files: {
    "src/a.ts": { path: "src/a.ts", mtime: 1, size: 1 },
    "README.md": { path: "README.md", mtime: 1, size: 1 },
  } as any,
});

const noop = () => {};
const group = (recent: string[], deepLinking: boolean, onOpen: (g: string, p: string) => void) => (
  <EditorGroup
    instance="t"
    vaultId="vault-1"
    group={{ id: "g1", tabs: [], active: null } as any}
    focused
    leftInset={false}
    rightInset={false}
    canSplit
    recent={recent}
    deepLinking={deepLinking}
    renderNote={() => null}
    onFocusGroup={noop}
    onActivate={noop}
    onOpen={onOpen}
    onClose={noop}
    onKeep={noop}
    onMove={noop}
    onMenu={noop}
    onSplit={noop}
  />
);

test("an empty group lists recent files still on disk and opens one on click", async () => {
  const opened: string[] = [];
  const host = await mount(group(["src/a.ts", "src/gone.ts", "README.md"], false, (_g, p) => opened.push(p)));
  const rows = [...host.querySelectorAll('[aria-label="Recent files"] button')];
  expect(rows.map((r) => r.textContent)).toEqual(["a.tssrc", "README.md"]);
  await act(async () => (rows[0] as HTMLButtonElement).click());
  expect(opened).toEqual(["src/a.ts"]);
  expect(host.textContent).toContain("Go to file");
  expect(host.textContent).toContain("Search");
});

test("its key hints are buttons that run their commands", async () => {
  const ran: string[] = [];
  const offs = [registerCodeCommand("quickOpen", () => void ran.push("quickOpen")), registerCodeCommand("search.project", () => void ran.push("search"))];
  try {
    const host = await mount(group([], false, noop));
    expect(host.querySelector('[aria-label="Recent files"]')).toBeNull();
    const buttons = [...host.querySelectorAll("button")];
    await act(async () => {
      buttons.find((b) => b.textContent?.startsWith("Go to file"))!.click();
      buttons.find((b) => b.textContent?.startsWith("Search"))!.click();
    });
    expect(ran).toEqual(["quickOpen", "search"]);
  } finally {
    offs.forEach((off) => off());
  }
});

test("while a deep link resolves the empty group draws nothing", async () => {
  const host = await mount(group(["src/a.ts"], true, noop));
  expect(host.textContent).not.toContain("Go to file");
  expect(host.querySelector('[aria-label="Recent files"]')).toBeNull();
});

test("quick open offers a typed path the scan lacks, and opens it on Enter", async () => {
  const opened: string[] = [];
  const host = await mount(<QuickOpen vaultId="vault-1" recent={[]} initialQuery="dist/gen/out.js:12" onOpen={(p, at) => opened.push(`${p}@${at}`)} onGotoLine={noop} onClose={noop} />);
  expect(host.textContent).toContain("Opendist/gen/out.js");
  const input = host.querySelector("input")!;
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(opened).toEqual(["dist/gen/out.js@12"]);
});

test("quick open with no match and no path says so in two words", async () => {
  const host = await mount(<QuickOpen vaultId="vault-1" recent={[]} initialQuery="zzzqqq" onOpen={noop} onGotoLine={noop} onClose={noop} />);
  expect(host.textContent).toContain("No match");
  expect(host.textContent).not.toContain("Open");
});
