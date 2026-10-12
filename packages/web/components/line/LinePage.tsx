"use client";
// /line (docs/architecture/line-workspace.md LW1): the line app over every
// project, `?project=` filtering it to one. One process, many projects.
import { LineWorkspace } from "./workspace/LineWorkspace";

export function LinePage() {
  return <LineWorkspace />;
}
