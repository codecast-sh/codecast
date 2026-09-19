"use client";
// /routines: the one Workflows entry (docs/architecture/the-line.md L10).
// The tab shell already routes /routines to the workflows page
// (components/RoutePane.tsx); this file gives a direct load the same page.
// /workflows keeps working as the older address of the same surface.
//
// Rendered rather than re-exported: `export { default } from …` is not a
// component declaration, so the module stops being a Fast Refresh boundary
// and every save of it re-executes its importers.
import WorkflowsPage from "../workflows/page";

export default function RoutinesPage() {
  return <WorkflowsPage />;
}
