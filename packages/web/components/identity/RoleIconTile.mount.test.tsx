// RoleIconTile draws a role's icon as the canonical markup roleIconSvg builds,
// or the first letter of its title when it has no valid icon; RoleFace picks
// that tile over the animal for a viewer with characters off, reading the
// icon from the role rows when the caller only knows the handle.
import assert from "node:assert/strict";
import { afterAll, test } from "bun:test";
import { ROLE_ICON_EXAMPLES } from "@codecast/shared/contracts/roleIconExamples";
import { roleIconSvg, roleIconStroke } from "@codecast/shared/contracts/roleIcon";

const ICON = ROLE_ICON_EXAMPLES[0].icon;

async function mount() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node"]) {
    (globalThis as Record<string, unknown>)[key] = (dom.window as unknown as Record<string, unknown>)[key];
  }
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  return { React, host, render: (el: unknown) => act(async () => { root.render(el as never); }) };
}

test("RoleIconTile renders the canonical svg, a monogram without an icon, and a monogram for an invalid one", async () => {
  const { React, host, render } = await mount();
  const { RoleIconTile } = await import("./RoleIconTile");
  const { roleTile } = await import("../../lib/sessionIdentity");
  await render(React.createElement(React.Fragment, null,
    React.createElement(RoleIconTile, { tile: roleTile({ name: "Infra lead", handle: "infra", icon: ICON }), size: 22 }),
    React.createElement(RoleIconTile, { tile: roleTile({ name: "Head of Growth", handle: "growth" }) }),
    React.createElement(RoleIconTile, { tile: roleTile({ name: "Finance lead", handle: "fin", icon: { ...ICON, shapes: [{ t: "script" }] } }) }),
  ));
  const tiles = [...host.querySelectorAll(".role-tile")] as HTMLElement[];
  assert.equal(tiles.length, 3);
  assert.equal(tiles[0].dataset.roleTile, ICON.concept);
  assert.equal(tiles[0].getAttribute("aria-label"), "Infra lead");
  assert.equal(tiles[0].style.width, "22px");
  // The DOM reserializes self-closed shapes, so compare against the canonical markup parsed the same way.
  const canonical = host.ownerDocument.createElement("div");
  canonical.innerHTML = roleIconSvg(ICON, { strokeWidth: roleIconStroke(22) });
  assert.equal(tiles[0].querySelector(".role-tile-glyph")!.innerHTML, canonical.innerHTML);
  assert.equal(tiles[1].dataset.roleTile, "monogram");
  assert.equal(tiles[1].textContent, "G");
  assert.equal(tiles[1].querySelector("svg"), null);
  assert.equal(tiles[2].dataset.roleTile, "monogram");
  assert.equal(tiles[2].textContent, "F");
});

test("RoleFace draws the animal with characters on and the role's tile from viewerRoles with them off", async () => {
  const { React, host, render } = await mount();
  const { useInboxStore } = await import("../../store/inboxStore");
  const { RoleFace } = await import("../org/RoleFace");
  const before = useInboxStore.getState();
  afterAll(() => useInboxStore.setState({ clientState: before.clientState, orgTree: before.orgTree, viewerRoles: (before as any).viewerRoles } as never));
  // The face fields live in viewerRoles; the org tree only says which role a bare handle means here.
  useInboxStore.setState({
    viewerRoles: { r1: { _id: "r1", short_id: "or-1", handle: "infra", name: "Infrastructure lead", icon: ICON } },
    orgTree: { roles: [{ _id: "r1", handle: "infra" }], anchors: [], workspace: { kind: "user", id: "me" } },
  } as never);
  const face = React.createElement(RoleFace, { role: { handle: "infra", avatar: "owl" }, size: 20 });

  await render(face);
  assert.equal(host.querySelector("img")?.dataset.avatar, "owl");
  assert.equal(host.querySelector(".role-tile"), null);

  useInboxStore.setState((s: any) => ({ clientState: { ...s.clientState, ui: { ...s.clientState?.ui, show_characters: false } } }));
  await render(face);
  const tile = host.querySelector(".role-tile") as HTMLElement;
  assert.ok(tile, "a tile replaces the animal");
  assert.equal(host.querySelector("img"), null);
  assert.equal(tile.dataset.roleTile, ICON.concept);
  assert.equal(tile.getAttribute("aria-label"), "Infrastructure lead");
});

test("a role named by id or short id wears the rows' face; one named by handle alone keeps the face it brought", async () => {
  const { React, host, render } = await mount();
  const { useInboxStore } = await import("../../store/inboxStore");
  const { RoleFace } = await import("../org/RoleFace");
  const before = useInboxStore.getState();
  afterAll(() => useInboxStore.setState({ clientState: before.clientState, orgTree: before.orgTree, viewerRoles: (before as any).viewerRoles } as never));
  useInboxStore.setState((s: any) => ({
    viewerRoles: { r1: { _id: "r1", short_id: "or-1", handle: "infra", name: "Infrastructure lead", avatar: "stag", icon: ICON } },
    orgTree: { roles: [{ _id: "r1", handle: "infra" }], anchors: [], workspace: { kind: "user", id: "me" } },
    clientState: { ...s.clientState, ui: { ...s.clientState?.ui, show_characters: true } },
  }) as never);
  const both = (a: object, b: object) => React.createElement(React.Fragment, null, React.createElement(RoleFace, { role: a as never }), React.createElement(RoleFace, { role: b as never }));
  // A chat seat names its role by short id and carries a stale face; a hire preview names a taken handle with the face being chosen.
  await render(both({ short_id: "or-1", handle: "infra", avatar: "owl" }, { handle: "infra", avatar: "owl" }));
  assert.deepEqual([...host.querySelectorAll("img")].map((i) => (i as HTMLElement).dataset.avatar), ["stag", "owl"]);

  useInboxStore.setState((s: any) => ({ clientState: { ...s.clientState, ui: { ...s.clientState?.ui, show_characters: false } } }) as never);
  // A template says it has no icon; it does not borrow the hired role's.
  await render(both({ _id: "r1", handle: "infra", icon: null }, { handle: "infra", name: "Infra template", icon: null }));
  assert.deepEqual([...host.querySelectorAll(".role-tile")].map((t) => (t as HTMLElement).dataset.roleTile), [ICON.concept, "monogram"]);
});

test("in a nav rail a role draws its glyph alone, and a bare handle never borrows a role from another workspace's cached tree", async () => {
  const { React, host, render } = await mount();
  const { useInboxStore } = await import("../../store/inboxStore");
  const { RoleFace } = await import("../org/RoleFace");
  const before = useInboxStore.getState();
  afterAll(() => useInboxStore.setState({ clientState: before.clientState, orgTree: before.orgTree, viewerRoles: (before as any).viewerRoles } as never));
  useInboxStore.setState((s: any) => ({
    viewerRoles: { r1: { _id: "r1", short_id: "or-1", handle: "infra", name: "Infrastructure lead", avatar: "stag", icon: ICON } },
    orgTree: { roles: [{ _id: "r1", handle: "infra" }], anchors: [], workspace: { kind: "user", id: "me" } },
    clientState: { ...s.clientState, ui: { ...s.clientState?.ui, show_characters: false, active_team_id: null } },
  }) as never);
  await render(React.createElement(RoleFace, { role: { _id: "r1", handle: "infra" }, size: 20, bare: true }));
  const glyph = host.querySelector("[data-role-glyph]") as HTMLElement;
  assert.equal(glyph.dataset.roleGlyph, ICON.concept);
  assert.equal(host.querySelector(".role-tile"), null, "no tile, no accent");
  assert.equal(glyph.querySelector("svg")!.getAttribute("stroke"), "currentColor");
  assert.equal(glyph.querySelector("svg")!.getAttribute("stroke-width"), "1.5");

  // Switched to a team; the cached tree is still the personal one.
  useInboxStore.setState((s: any) => ({ clientState: { ...s.clientState, ui: { ...s.clientState.ui, active_team_id: "team-union" } } }) as never);
  await render(React.createElement(RoleFace, { role: { handle: "infra", name: "Infrastructure lead" }, size: 20 }));
  assert.equal((host.querySelector(".role-tile") as HTMLElement).dataset.roleTile, "monogram");
});
