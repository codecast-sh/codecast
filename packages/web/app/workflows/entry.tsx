// /routines: the workflows page.
import { lazy } from "react";

const WorkflowsPage = lazy(() => import("./page"));

export default function RoutinesEntry() {
  return <WorkflowsPage />;
}
