// /routines: the workflows page wherever it shows. Hosted mode hides it and
// calls the triggers page "Routines", so there the address goes to /triggers
// (lib/laneRedirect.ts PAGE_ALIASES), never a blank pane.
import { lazy } from "react";
import { Navigate, useLocation } from "react-router";
import { useSurface } from "../../lib/surfaces";
import { pageAliasTarget } from "../../lib/laneRedirect";

const WorkflowsPage = lazy(() => import("./page"));

export default function RoutinesEntry() {
  const shown = useSurface("nav.workflows");
  const { pathname, search, hash } = useLocation();
  const alias = shown ? null : pageAliasTarget(pathname, search, hash);
  return alias ? <Navigate to={alias} replace /> : <WorkflowsPage />;
}
