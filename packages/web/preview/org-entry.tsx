// Preview entry: the REAL org role cards over a fixture world, for eyeballing
// the staffing 2 surfaces without a backend (docs/architecture/org-staffing.md
// S10 tenure chips, S13 faces, S5 ghost seats, S16 the seat dialog). The cards
// are the shipped components in a real React Flow context, so what renders here
// is what the org page renders. `?theme=light` flips the theme; default dark.
// `?view=seat` shows the seat dialog instead of the cards.
import "../app/globals.css";
import "@xyflow/react/dist/style.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { ReactFlow, ReactFlowProvider, type Node } from "@xyflow/react";
import { RoleCard, type RoleNodeData } from "../components/org/OrgNodeCards";
import { ChiefSeatDialog } from "../components/org/ChiefSeatDialog";
import { ORG_SIZES } from "../components/org/orgLayout";
import { EMPTY_COUNTS, type OrgRole } from "../components/org/orgTypes";

const params = new URLSearchParams(window.location.search);
document.documentElement.classList.add(params.get("theme") === "light" ? "light" : "dark");

const base = (over: Partial<OrgRole>): OrgRole => ({
  _id: "r", short_id: "or-1", scope_type: "team", team_id: "t", host_user_id: "u",
  name: "Head of Growth", handle: "growth",
  scope: { project_ids: [], plan_ids: [] },
  reports_to: { kind: "user", user_id: "u" },
  status: "active", trust: "understand",
  created_by: "u", created_at: Date.now(), updated_at: Date.now(),
  counts: { ...EMPTY_COUNTS, working: 2, needs_input: 1, done: 3 },
  sessions: [], total: 6,
  scope_names: { projects: [{ id: "p1", title: "Growth" }], plans: [] },
  ...over,
});

// One card per thing worth seeing: a standing seat (tenure silent), a program
// ending with a plan, one ending with a date, one ending with a project, and a
// proposed ghost seat carrying its own tenure and face.
const ROLES: { role: OrgRole; ghost?: RoleNodeData["ghost"] }[] = [
  { role: base({ _id: "a", short_id: "or-1", name: "Head of Growth", handle: "growth", avatar: "fox" }) },
  {
    role: base({
      _id: "b", short_id: "or-2", name: "Sync Migration", handle: "sync-migration", avatar: "otter",
      tenure: { kind: "program", ends: { plan: "pl-689" }, then: "retire" },
    }),
  },
  {
    role: base({
      _id: "c", short_id: "or-3", name: "Launch Push", handle: "launch", avatar: "crane",
      tenure: { kind: "program", ends: { date: new Date("2026-10-03T00:00:00Z").getTime() }, then: "review" },
    }),
  },
  {
    role: base({
      _id: "d", short_id: "or-4", name: "Mobile Platform", handle: "mobile", avatar: "whale",
      tenure: { kind: "program", ends: { project: "Mobile" }, then: "retire" },
    }),
  },
  {
    role: base({
      _id: "e", short_id: "or-…", name: "Infra Lead", handle: "infra", avatar: "owl",
      tenure: { kind: "program", ends: { plan: "pl-712" }, then: "retire" },
    }),
    ghost: { change_id: "c1", status: "proposed", line: "Create role Infra Lead @infra", kind: "role", solid: false },
  },
];

const nodes: Node[] = ROLES.map((r, i) => ({
  id: r.role._id,
  type: "role",
  position: { x: 40 + (i % 3) * (ORG_SIZES.role.w + 48), y: 40 + Math.floor(i / 3) * (ORG_SIZES.role.h + 90) },
  draggable: false,
  data: { role: r.role, collapsed: false, hidden: 0, overflow: 0, ...(r.ghost ? { ghost: r.ghost } : {}) } as unknown as Record<string, unknown>,
  // The same height the layout gives a seat: a program takes an extra row.
  style: { width: ORG_SIZES.role.w, height: ORG_SIZES.role.h + (r.role.tenure?.kind === "program" ? ORG_SIZES.tenureRow : 0) },
}));

function Cards() {
  return (
    <div className="min-h-screen bg-sol-bg text-sol-text">
      <div className="px-6 py-5">
        <h1 className="text-lg font-semibold" style={{ fontFamily: "var(--font-serif)" }}>Org role cards</h1>
        <p className="text-xs text-sol-text-muted mt-1">
          Faces (S13) and tenure chips (S10) on live seats and on a proposed ghost seat (S5). Standing seats say nothing about tenure; a program names its end.
        </p>
      </div>
      <div style={{ height: 520 }}>
        <ReactFlowProvider>
          <ReactFlow nodes={nodes} edges={[]} nodeTypes={{ role: RoleCard }} fitView proOptions={{ hideAttribution: true }} />
        </ReactFlowProvider>
      </div>
    </div>
  );
}

function Seat() {
  return (
    <div className="min-h-screen bg-sol-bg text-sol-text">
      <ChiefSeatDialog
        open
        onClose={() => {}}
        agentName="Anchor"
        threadShortId="jx7abcd"
        messageCount={412}
        onConfirm={() => {}}
      />
    </div>
  );
}

// The cards link to scope pages through the next/link compat shim, which uses
// react-router's navigate — so the preview needs a router in the tree.
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MemoryRouter>{params.get("view") === "seat" ? <Seat /> : <Cards />}</MemoryRouter>
  </React.StrictMode>,
);
