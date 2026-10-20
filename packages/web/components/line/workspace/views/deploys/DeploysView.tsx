// The Line app's Deploys view (docs/architecture/deploys.md DP7): what waits to
// go out, the deploys that went, and one deploy whole.
import type { LineViewProps } from "../types";

export function DeploysView({ workspace }: LineViewProps) {
  return <div className="lw-deploys" data-line-deploys>{workspace.deploys.length} deploys</div>;
}
