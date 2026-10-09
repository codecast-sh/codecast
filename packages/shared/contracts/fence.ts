// Fencing foreign text before an agent reads it. The implementation lives in
// @platform/fence, shared with the hosted assistant's harness
// (@platform/agent's `untrusted`), so every agent is taught one delimiter and
// every fence has the same defenses. Writers here: `cast cap show`
// (publisher-controlled capability descriptions printed into a terminal an
// agent is reading), the task prompt a spawned run receives, and
// `cast task context`.
export {
  FOREIGN_TEXT_CAPS,
  FOREIGN_TEXT_TRUNCATION_MARKER,
  capForeignText,
  escapeForeignControlChars,
  fenceForeignText,
  fenceNonce,
  inlineForeignText,
  type FenceOptions,
} from "@platform/fence";
import { fenceForeignText } from "@platform/fence";

/**
 * Fence only when the text needs it.
 *
 * Builtin capabilities' own descriptions are ours; fencing them would train
 * readers that the delimiter is noise. The rule mirrors the store's trust
 * boundary: anything whose slug is not `builtin/` came from outside.
 */
export function fenceUnlessBuiltin(text: string, slug: string, provenance: string): string {
  return slug.startsWith("builtin/") ? text : fenceForeignText(text, provenance);
}
