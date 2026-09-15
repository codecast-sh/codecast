// Mounts the ghost cards in jsdom (org-staffing.md S5) against the fixture
// tree and a proposal covering every kind: a proposed role stub (dashed,
// proposed tag, action row), an accepted one (solid), a retire hatch, dashed
// chips with a focused change's action row, an adopt "this session" stub, and
// the health dots. Clicks on Accept, Edit, Skip and a chip reach the handlers.
// Run: bun components/org/OrgGhosts.mount.test.tsx
import assert from "node:assert/strict";

async function verifyGhostCards() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "getComputedStyle", "ResizeObserver", "DOMMatrixReadOnly"]) {
    if ((dom.window as any)[key] !== undefined) Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
  }
  if (typeof (globalThis as any).ResizeObserver === "undefined") (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const React = await import("react");
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  mock.module("../ConversationList", () => ({ AgentIcon: () => React.createElement("span", { "data-agent": true }) }));
  mock.module("../tasks/TaskCommentStream", () => ({ Avatar: ({ name }: { name: string }) => React.createElement("span", { "data-avatar": name }) }));
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { ReactFlowProvider } = await import("@xyflow/react");
  const { PersonCard, RoleCard, SessionCard } = await import("./OrgNodeCards");
  const { ghostsFor, layoutOrgTree, personNodeId, roleNodeId, sessionNodeId } = await import("./orgLayout");
  const { ORG_FIXTURE } = await import("./orgFixture");
  const { ORG_STAFFING_FIXTURE_HEALTH } = await import("./orgStaffingFixture");
  const { healthFlagsByNode } = await import("./orgMeta");

  const change = (id: string, c: any, status: any = "proposed") => ({ _id: id, proposal_id: "p", seq: 1, change: c, rationale: "r", evidence: [], status });
  const changes = [
    change("c-role", { kind: "role", name: "Head of Platform", handle: "platform", reports_to: "me", scope: { projects: ["Platform"] } }),
    change("c-role-acc", { kind: "role", name: "Content Lead", handle: "content", reports_to: "@growth" }, "accepted"),
    change("c-retire", { kind: "retire", handle: "growth" }),
    change("c-budget", { kind: "budget", handle: "growth", caps: { tokens_per_day: 800_000 } }),
    change("c-routine", { kind: "routine", handle: "growth", title: "Weekly review", prompt: "p", every: "7d" }),
    change("c-file", { kind: "file", plan: "pl-999", project: "Nowhere" }),
    change("c-adopt", { kind: "adopt", handle: "growth", conversation: "jx7abcd" }),
  ];
  const ghosts = ghostsFor(ORG_FIXTURE, changes, { viewerSession: { short_id: "jx7abcd" } });
  const layout = layoutOrgTree(ORG_FIXTURE, { collapsed: new Set(), expanded: {} }, ghosts);
  const node = (id: string) => layout.nodes.find((n) => n.id === id) as any;
  const flags = healthFlagsByNode(ORG_STAFFING_FIXTURE_HEALTH);

  const calls: string[] = [];
  const handlers = {
    focusChangeId: "c-budget",
    onFocusChange: (id: string) => calls.push(`focus:${id}`),
    onDecideChange: (id: string, v: string) => calls.push(`decide:${id}:${v}`),
    onEditChange: (id: string) => calls.push(`edit:${id}`),
  };
  const card = (Comp: any, n: any, extra: any = {}) => React.createElement(Comp as any, {
    id: n.id, type: n.kind, selected: false, dragging: false, zIndex: 0, isConnectable: false, positionAbsoluteX: 0, positionAbsoluteY: 0,
    data: { ...(n.kind === "person" ? { person: n.person } : n.kind === "role" ? { role: n.role } : { session: n.session, parent: n.parent }), collapsed: false, hidden: 0, overflow: 0, ghost: n.ghost, retire: n.retire, move: n.move, chips: n.chips, flags: flags[n.id], ...handlers, ...extra },
  });

  const root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root.render(React.createElement(ReactFlowProvider, null,
      React.createElement("div", { "data-card": "ghost-role" }, card(RoleCard, node(roleNodeId("c-role")))),
      React.createElement("div", { "data-card": "solid-role" }, card(RoleCard, node(roleNodeId("c-role-acc")))),
      React.createElement("div", { "data-card": "growth" }, card(RoleCard, node(roleNodeId("fixture-role-growth")))),
      React.createElement("div", { "data-card": "me" }, card(PersonCard, node(personNodeId("fixture-user-me")))),
      React.createElement("div", { "data-card": "adopt" }, card(SessionCard, node(sessionNodeId("c-adopt")))),
    ));
  });
  const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
  const qa = (sel: string) => Array.from(document.querySelectorAll(sel)) as HTMLElement[];

  // A proposed role: dashed, translucent, tagged, with an action row.
  const ghostRole = q("[data-card='ghost-role']")!;
  assert.equal(ghostRole.querySelector("[data-ghost-tag='proposed']") !== null, true, "proposed tag on the ghost role");
  assert.equal(ghostRole.querySelector("[data-ghost-actions='c-role']") !== null, true, "action row on the ghost role");
  assert.ok(ghostRole.textContent?.includes("@platform") && ghostRole.textContent?.includes("Head of Platform"));
  assert.ok(ghostRole.textContent?.includes("Platform"), "scope chip");
  assert.equal(ghostRole.querySelector("a[href^='/org/']"), null, "a ghost has no scope page to open");
  // An accepted stub is solid: its word instead of buttons.
  const solid = q("[data-card='solid-role']")!;
  assert.ok(solid.querySelector("[data-ghost-actions='c-role-acc']")?.textContent?.includes("accepted"));
  assert.equal(solid.querySelectorAll("button[aria-label='Accept']").length, 0);
  // Retire hatch + chips on growth; the focused chip shows its action row.
  const growth = q("[data-card='growth']")!;
  assert.ok(growth.querySelector("[data-ghost-retire='c-retire']"), "retire hatch");
  assert.ok(growth.querySelector("[data-ghost-tag='retire']"), "retire tag");
  assert.equal(growth.querySelector("[data-ghost-chips]")?.getAttribute("data-ghost-chips"), "2");
  assert.ok(growth.querySelector("[data-ghost-actions='c-budget']"), "the focused chip's action row");
  assert.ok(growth.querySelector("[data-ghost-chip='c-budget']")?.getAttribute("aria-pressed") === "true");
  // Health dots on growth (3 flags in the fixture), none on Sam.
  assert.equal(growth.querySelector("[data-flags]")?.getAttribute("data-flags"), "overloaded,cap_hit,review_stall");
  // The orphan file chip landed on the viewer's card.
  const me = q("[data-card='me']")!;
  assert.ok(me.querySelector("[data-ghost-chip='c-file']"), "file chip on the viewer");
  // Adopt: "this session".
  const adopt = q("[data-card='adopt']")!;
  assert.ok(adopt.querySelector("[data-ghost-tag='this session']"), "this session tag");
  assert.ok(adopt.textContent?.includes("This session") && adopt.textContent?.includes("jx7abcd"));

  // Clicks reach the handlers.
  await act(async () => { (ghostRole.querySelector("button[aria-label='Accept']") as HTMLElement).click(); });
  await act(async () => { (growth.querySelector("[data-ghost-actions='c-budget'] button[aria-label='Edit']") as HTMLElement).click(); });
  await act(async () => { (ghostRole.querySelector("button[aria-label='Skip']") as HTMLElement).click(); });
  await act(async () => { (growth.querySelector("[data-ghost-chip='c-routine']") as HTMLElement).click(); });
  assert.deepEqual(calls, ["decide:c-role:accept", "edit:c-budget", "decide:c-role:skip", "focus:c-routine"]);

  await act(async () => { root.unmount(); });
  console.log("OrgGhosts mount: ok");
}

verifyGhostCards().catch((e) => { console.error(e); process.exit(1); });
