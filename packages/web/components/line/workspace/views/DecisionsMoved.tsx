"use client";
// The Line app's old Decisions address (`view=foryou`): decisions have one
// home, the Decisions page, where the flows' are the "Every flow" source. The
// address is replaced, so Back skips this hop.
import { useRouter } from "next/navigation";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { flowDecisionsHref } from "../../../../lib/decisions/decisionSet";
import type { LineViewProps } from "./types";

export function DecisionsMoved({ selection }: LineViewProps) {
  const router = useRouter();
  const to = flowDecisionsHref(selection);
  useWatchEffect(() => { router.replace(to); }, [to]);
  return null;
}
