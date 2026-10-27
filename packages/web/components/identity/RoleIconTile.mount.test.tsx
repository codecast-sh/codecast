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
    orgTree: { roles: [{ _id: "r1", handle: "infra" }], anchors: [] },
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
