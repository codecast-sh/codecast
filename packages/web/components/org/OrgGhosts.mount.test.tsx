// Mounts the ghost cards in jsdom (org-staffing.md S5) against the fixture
// tree and a proposal covering every kind: a proposed role stub (dashed,
// proposed tag, action row led by the kind word, never a drop halo), an
// accepted one (solid), a retire hatch, dashed chips carrying the delta with a
// focused change's action row, a warning chip for a handle nothing answers
// to, an adopt "this session" stub with its second line, and the health dots
// (blocker filled, warn a ring, info none). Clicks on Accept, Edit, Skip and
// a chip reach the handlers.
// Run: bun components/org/OrgGhosts.mount.test.tsx
import { test } from "bun:test";
import assert from "node:assert/strict";

async function verifyGhostCards() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "getComputedStyle", "ResizeObserver", "DOMMatrixReadOnly"]) {
    if ((dom.window as any)[key] !== undefined) Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
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
  const { ghostsFor, layoutOrgTree, personNodeId, roleNodeId, sessionNodeId, ORG_SIZES } = await import("./orgLayout");
  const { ORG_FIXTURE } = await import("./orgFixture");
  const { ORG_STAFFING_FIXTURE_HEALTH } = await import("./orgStaffingFixture");
  const { healthFlagsByNode } = await import("./orgMeta");

  const change = (id: string, c: any, status: any = "proposed") => ({ _id: id, proposal_id: "p", seq: 1, change: c, rationale: "r", evidence: [], status });
  const changes = [
    change("c-role", { kind: "role", name: "Head of Platform", handle: "platform", reports_to: "me", scope: { projects: ["Platform"] } }),
    change("c-role-seat", { kind: "role", name: "Market growth mandate", handle: "market-growth", reports_to: "me", seat: { existing: "jx7b88a", title: "Market growth mandate", started_at: Date.now() - 34 * 86_400_000 - 3_600_000, helpers: 391 } }),
    change("c-role-acc", { kind: "role", name: "Content Lead", handle: "content", reports_to: "@growth" }, "accepted"),
    change("c-retire", { kind: "retire", handle: "growth" }),
    change("c-budget", { kind: "budget", handle: "growth", caps: { tokens_per_day: 800_000 } }),
    change("c-routine", { kind: "routine", handle: "growth", title: "Weekly review", prompt: "p", every: "7d" }),
    change("c-file", { kind: "file", plan: "pl-999", project: "Nowhere" }),
    change("c-adopt", { kind: "adopt", handle: "growth", conversation: "jx7abcd" }),
    change("c-orphan", { kind: "trust", handle: "nobody", trust: "decide" }),
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
      React.createElement("div", { "data-card": "ghost-role" }, card(RoleCard, node(roleNodeId("c-role")), { dropTarget: true })),
      React.createElement("div", { "data-card": "seat-role" }, card(RoleCard, node(roleNodeId("c-role-seat")))),
      React.createElement("div", { "data-card": "solid-role" }, card(RoleCard, node(roleNodeId("c-role-acc")))),
      React.createElement("div", { "data-card": "growth" }, card(RoleCard, node(roleNodeId("fixture-role-growth")))),
      React.createElement("div", { "data-card": "me" }, card(PersonCard, node(personNodeId("fixture-user-me")), { flags: [{ code: "unowned", severity: "blocker", detail: "Platform has no owner role" }, { code: "chatter", severity: "info", detail: "quiet" }] })),
      React.createElement("div", { "data-card": "adopt" }, card(SessionCard, node(sessionNodeId("c-adopt")))),
    ));
  });
  const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
  const qa = (sel: string) => Array.from(document.querySelectorAll(sel)) as HTMLElement[];

  // A proposed role: dashed, translucent, tagged, with an action row that
  // names its kind; a drop on it is never offered (no halo, no scale).
  const ghostRole = q("[data-card='ghost-role']")!;
  assert.equal(ghostRole.querySelector("[data-ghost-tag='proposed']") !== null, true, "proposed tag on the ghost role");
  assert.equal(ghostRole.querySelector("[data-ghost-actions='c-role']") !== null, true, "action row on the ghost role");
  assert.equal(ghostRole.querySelector("[data-ghost-word]")?.getAttribute("data-ghost-word"), "role");
  assert.equal(ghostRole.querySelector("button[aria-label='Accept role']") !== null, true, "Accept names the change");
  assert.equal((ghostRole.firstElementChild as HTMLElement).style.transform, "", "no drop halo on a stub");
  assert.ok(ghostRole.textContent?.includes("@platform") && ghostRole.textContent?.includes("Head of Platform"));
  assert.ok(ghostRole.textContent?.includes("Platform"), "scope chip");
  assert.equal(ghostRole.querySelector("a[href^='/org/']"), null, "a ghost has no scope page to open");
  // A ghost that names a session which already works as the role (R2) says
  // what naming changes, whole, in a row the layout booked; a plain ghost has none.
  const seatRole = q("[data-card='seat-role']")!;
  const sentence = "This is Market growth mandate, which has run for 34 days with 391 helper sessions. Naming it changes nothing about how it works and gives it a place on the chart.";
  assert.equal(seatRole.querySelector("[data-ghost-seat='jx7b88a']")?.textContent?.trim(), sentence);
  assert.equal(ghostRole.querySelector("[data-ghost-seat]"), null, "a role with a fresh session says nothing about naming");
  const rows = Math.ceil(sentence.length / ORG_SIZES.seatChars);
  assert.equal(node(roleNodeId("c-role-seat")).h - node(roleNodeId("c-role")).h, 6 + rows * ORG_SIZES.seatLine, "the layout books the sentence's height");
  assert.equal((seatRole.querySelector("[data-ghost-seat]") as HTMLElement).style.height, `${rows * ORG_SIZES.seatLine}px`);
  // An accepted stub is solid: its word instead of buttons.
  const solid = q("[data-card='solid-role']")!;
  assert.ok(solid.querySelector("[data-ghost-actions='c-role-acc']")?.textContent?.includes("accepted"));
  assert.equal(solid.querySelectorAll("button[aria-label^='Accept']").length, 0);
  // Retire hatch + chips on growth; the focused chip shows its action row.
  const growth = q("[data-card='growth']")!;
  assert.ok(growth.querySelector("[data-ghost-retire='c-retire']"), "retire hatch");
  assert.ok(growth.querySelector("[data-ghost-tag='retire']"), "retire tag");
  assert.equal(growth.querySelector("[data-ghost-chips]")?.getAttribute("data-ghost-chips"), "2");
  assert.ok(growth.querySelector("[data-ghost-actions='c-budget']"), "the focused chip's action row");
  assert.equal(growth.querySelector("[data-ghost-actions='c-budget'] [data-ghost-word]")?.getAttribute("data-ghost-word"), "budget");
  assert.ok(growth.querySelector("[data-ghost-chip='c-budget']")?.getAttribute("aria-pressed") === "true");
  // A chip carries the delta, not the sentence; the sentence is its title.
  assert.equal(growth.querySelector("[data-ghost-chip='c-budget']")?.textContent?.trim(), "tokens 800k");
  assert.ok(growth.querySelector("[data-ghost-chip='c-budget']")?.getAttribute("title")?.startsWith("@growth may use up to"));
  assert.equal(growth.querySelector("[data-ghost-chip='c-routine']")?.textContent?.trim(), "every 7d · Weekly review");
  // Health dots on growth: its two warnings as rings; the info flag draws
  // none (the pane lists it).
  assert.equal(growth.querySelector("[data-flags]")?.getAttribute("data-flags"), "overloaded,cap_hit");
  const rings = Array.from(growth.querySelectorAll("[data-flags] [data-severity]")) as HTMLElement[];
  assert.deepEqual(rings.map((d) => d.getAttribute("data-severity")), ["warn", "warn"]);
  assert.ok(rings.every((d) => d.style.border !== ""), "a warning is a ring");
  // On the viewer's card a blocker is a filled dot and the info flag is not drawn.
  const me = q("[data-card='me']")!;
  const meDots = Array.from(me.querySelectorAll("[data-flags] [data-severity]")) as HTMLElement[];
  assert.deepEqual(meDots.map((d) => d.getAttribute("data-severity")), ["blocker"]);
  assert.ok(meDots[0].style.border === "" && meDots[0].style.background !== "", "a blocker is filled");
  assert.ok(meDots[0].getAttribute("title")?.startsWith("blocker: no owner"), "the severity word is in the tooltip");
  // The orphan file chip landed on the viewer's card; so did the trust change
  // on a handle nothing answers to, as a warning.
  assert.ok(me.querySelector("[data-ghost-chip='c-file']"), "file chip on the viewer");
  const orphan = me.querySelector("[data-ghost-chip='c-orphan']") as HTMLElement;
  assert.ok(orphan, "unresolved handle drawn on the viewer");
  assert.ok(orphan.hasAttribute("data-unresolved"), "as a warning");
  assert.ok(orphan.getAttribute("title")?.includes("Nothing in this workspace answers to that handle"));
  // Adopt: two lines, an adopt tag and "this session".
  const adopt = q("[data-card='adopt']")!;
  assert.ok(adopt.querySelector("[data-ghost-tag='adopt']"), "adopt tag");
  assert.ok(adopt.querySelector("[data-ghost-tag='this session']"), "this session tag");
  assert.ok(adopt.textContent?.includes("This session") && adopt.textContent?.includes("jx7abcd"));
  assert.equal(adopt.querySelector("[data-adopt-line]")?.textContent?.trim(), "becomes @growth's standing session");
  assert.equal(adopt.querySelector("[data-ghost-word]")?.getAttribute("data-ghost-word"), "adopt");

  // Clicks reach the handlers.
  await act(async () => { (ghostRole.querySelector("button[aria-label='Accept role']") as HTMLElement).click(); });
  await act(async () => { (growth.querySelector("[data-ghost-actions='c-budget'] button[aria-label='Edit budget']") as HTMLElement).click(); });
  await act(async () => { (ghostRole.querySelector("button[aria-label='Skip role']") as HTMLElement).click(); });
  await act(async () => { (growth.querySelector("[data-ghost-chip='c-routine']") as HTMLElement).click(); });
  assert.deepEqual(calls, ["decide:c-role:accept", "edit:c-budget", "decide:c-role:skip", "focus:c-routine"]);

  await act(async () => { root.unmount(); });
  console.log("OrgGhosts mount: ok");
}

test("the ghost cards mount and their gestures reach the handlers", verifyGhostCards, 120_000);
