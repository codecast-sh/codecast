"use client";
// The Line app's old Decisions address (`view=foryou`): decisions have one
// home, the Decisions page. A count scoped to a line, a project or a flow
// ("3 waiting on you") opens exactly the decisions it counted, as a set to
// flip through; an unscoped one the "Every flow" source. The address is
// replaced, so Back skips this hop.
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { useOwnedFlows } from "../../../../hooks/useOwnedFlows";
import { flowDecisionsHref } from "../../../../lib/decisions/decisionSet";
import { needsOfLine } from "../../../../lib/line/lineNeeds";
import { flowNeeds, flowOf } from "../../../../lib/line/ownedFlows";
import type { LineViewProps } from "./types";

export function DecisionsMoved({ selection, workspace }: LineViewProps) {
  const router = useRouter();
  const flows = useOwnedFlows(workspace);
  const line = selection.process;
  const flow = selection.flow ? flowOf(flows, selection.flow) : null;
  const waiting = (!!line || !!selection.flow) && (!workspace.ready || (!!selection.flow && flows.length === 0));
  const to = useMemo(() => {
    if (waiting) return null;
    if (!line && !flow) return flowDecisionsHref(selection);
    const lineNeeds = needsOfLine(workspace.needs, line, line ? selection.project : null);
    return flowDecisionsHref(selection, flow ? flowNeeds(lineNeeds, flow) : lineNeeds);
  }, [waiting, line, flow, selection, workspace.needs]);
  useWatchEffect(() => { if (to) router.replace(to); }, [to]);
  return null;
}
