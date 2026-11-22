"use client";
// A pull request or commit pill's state, as its change (changes.md CH4): the
// track and word the Branches page gives the same pull request.
import { useRefLifecycle } from "../../hooks/useRefLifecycle";
import { ChangeSegment } from "./ChangeChip";

export function RefChangeSegment({ type, entity }: { type: "pr" | "commit"; entity: any }) {
  const lifecycle = useRefLifecycle(type, entity);
  return lifecycle ? <ChangeSegment lifecycle={lifecycle} /> : null;
}
