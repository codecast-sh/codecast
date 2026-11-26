import type { FileEditOutcome } from "./writeBack";

/** Outcomes the person has to act on: everything but a clean write or an
 *  edit into a buffer that was already dirty. */
export function needsAttention(o: Pick<FileEditOutcome, "status" | "detail">): boolean {
  return o.status !== "saved" && !(o.status === "unsaved" && !o.detail);
}
