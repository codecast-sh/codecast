// The opt in, as rendered (docs/architecture/session-characters.md S2/S3).
// Mount tests rather than assertions on JSX, because what matters is what the
// card actually puts in the DOM: a session nobody personified must render the
// way it always did, with no face and an undimmed title, and a personified one
// must lead with the name and dim what it is working on.
import assert from "node:assert/strict";
import { beforeAll, test } from "bun:test";

let dom: { window: Window & typeof globalThis };
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  dom = new JSDOM("<!doctype html><html><body></body></html>") as never;
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "getComputedStyle"]) {
    (globalThis as Record<string, unknown>)[key] = (dom.window as unknown as Record<string, unknown>)[key];
  }
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ act } = await import("react"));
});

const ID = "k97xcyp74gaa0q43my0mpnvnsd8ekyj4";

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(node as never); });
  return host as unknown as HTMLElement;
}

/** The switch lives in the store, so a test drives it the way the app does. */
async function setPersonifyAll(on: boolean) {
  const { useInboxStore } = await import("../../store/inboxStore");
  await act(async () => {
    useInboxStore.setState((s: Record<string, unknown>) => ({
      ...s,
      clientState: { ...((s.clientState as object) ?? {}), ui: { ...(((s.clientState as { ui?: object })?.ui) ?? {}), personify_sessions: on } },
    }) as never);
  });
}

test("a session nobody personified renders as it always did: no face, plain title", async () => {
  const { SessionIdentityLine } = await import("./SessionIdentityLine");
  const { IdentityFace } = await import("./IdentityFace");
  await setPersonifyAll(false);

  const face = await render(<IdentityFace row={{ _id: ID }} hover={false} />);
  assert.equal(face.querySelector("img"), null, "a plain row draws no face");

  const line = await render(<SessionIdentityLine row={{ _id: ID }} title="Fixing the auth race" />);
  assert.equal(line.textContent, "Fixing the auth race");
  // The title is the only thing on the line, so it must NOT be dimmed.
  const title = line.querySelector("span > span") as HTMLElement;
  assert.ok(title.className.includes("text-sol-text"), "an unpersonified title keeps full contrast");
  assert.ok(!title.className.includes("text-sol-text-dim"), "…and is not dimmed");
});

test("the workspace switch personifies a plain session without touching its row", async () => {
  const { IdentityFace } = await import("./IdentityFace");
  await setPersonifyAll(true);
  const face = await render(<IdentityFace row={{ _id: ID }} hover={false} />);
  assert.ok(face.querySelector("img"), "the switch alone gives an untouched row a face");
  await setPersonifyAll(false);
});

test("a personified session leads with the name and dims what it is working on", async () => {
  const { SessionIdentityLine } = await import("./SessionIdentityLine");
  await setPersonifyAll(false);
  const host = await render(
    <SessionIdentityLine row={{ _id: ID, character_name: "Ember", character_avatar: "fox" }} title="Fixing the auth race" />,
  );
  assert.equal(host.textContent, "Ember:Fixing the auth race");
  const spans = Array.from(host.querySelectorAll("span > span")) as HTMLElement[];
  const name = spans.find((s) => s.textContent === "Ember")!;
  const title = spans.find((s) => s.textContent === "Fixing the auth race")!;
  assert.ok(name.className.includes("text-sol-text") && name.className.includes("font-medium"), "the name is dominant");
  assert.ok(title.className.includes("text-sol-text-dim"), "the work is secondary");
  assert.ok(name.className.includes("flex-shrink-0"), "the name never truncates");
  assert.ok(title.className.includes("truncate"), "the title does");
});

test("the line carries the minimal style's title marker whether or not it is personified", async () => {
  const { SessionIdentityLine } = await import("./SessionIdentityLine");
  for (const row of [{ _id: ID }, { _id: ID, character_name: "Ember" }]) {
    const host = await render(<SessionIdentityLine row={row} title="Something" />);
    assert.ok(host.querySelector("[data-sv-title]"), "globals.css keys the 15px rule on this");
  }
});

test("a role's standing session wears the role and is personified without opting in", async () => {
  const { SessionIdentityLine } = await import("./SessionIdentityLine");
  const { IdentityFace } = await import("./IdentityFace");
  await setPersonifyAll(false);
  const row = {
    _id: ID,
    standing_role_id: "org_roles_infra",
    role: { _id: "org_roles_infra", short_id: "or-7", name: "Infra lead", handle: "infra", avatar: "stag", status: "active", tenure_kind: "standing" },
  };
  const face = await render(<IdentityFace row={row as never} hover={false} />);
  assert.ok(face.querySelector("img"), "a role always has a face");

  const line = await render(<SessionIdentityLine row={row as never} title="Rolling the canary" />);
  assert.equal(line.textContent, "Infra lead@infra:Rolling the canary");
  // A standing session's title IS the role's name, so it is not repeated.
  const same = await render(<SessionIdentityLine row={row as never} title="Infra lead" />);
  assert.equal(same.textContent, "Infra lead@infra");
});

test("a list's glyph: the face when personified, the surface's own mark when not", async () => {
  const { SessionGlyph } = await import("./SessionGlyph");
  await setPersonifyAll(false);
  const plain = await render(
    <SessionGlyph row={{ _id: ID }} fallback={<span data-old-mark>icon</span>} />,
  );
  assert.ok(!plain.querySelector("img"), "nobody opted in: no face");
  assert.ok(plain.querySelector("[data-old-mark]"), "the row keeps the mark it always had");

  const chosen = await render(
    <SessionGlyph row={{ _id: ID, character_avatar: "otter" }} fallback={<span data-old-mark>icon</span>} />,
  );
  assert.ok(chosen.querySelector("img"), "a chosen character shows its face");
  assert.ok(!chosen.querySelector("[data-old-mark]"), "and replaces the old mark");

  await setPersonifyAll(true);
  const all = await render(<SessionGlyph row={{ _id: ID }} fallback={<span data-old-mark>icon</span>} />);
  assert.ok(all.querySelector("img"), "the workspace switch personifies every row");
  await setPersonifyAll(false);
});
