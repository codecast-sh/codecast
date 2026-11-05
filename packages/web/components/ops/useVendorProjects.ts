// The vendor's projects for the workspace Ops reads (convex
// sources/vendorProjects listVendorProjects): one call per mount, its answer
// held for the component. The add-source picker lists them; the connect
// sheet names an existing PostHog source's project by them.
import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { VendorProjects } from "@codecast/convex/convex/sources/vendorProjects";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useOpsScope } from "../../hooks/useSyncOps";

/** Null while the answer is out; an error answer when the list cannot be read (or the function is not deployed yet). */
export function useVendorProjects(provider: "sentry" | "posthog" | null, onAnswer?: (a: VendorProjects) => void): VendorProjects | null {
  const scope = useOpsScope();
  const list = useAction(api.sources.vendorProjects.listVendorProjects);
  const [answer, setAnswer] = useState<VendorProjects | null>(null);
  useWatchEffect(() => {
    if (scope === "skip" || !provider) return;
    let live = true;
    list({ ...scope, provider } as any)
      .then((a: VendorProjects) => {
        if (!live) return;
        setAnswer(a);
        onAnswer?.(a);
      })
      .catch((e: any) => {
        if (!live) return;
        const a: VendorProjects = { ok: false, error: e?.data?.message ?? e?.message ?? "Could not list projects" };
        setAnswer(a);
        onAnswer?.(a);
      });
    return () => { live = false; };
  }, [provider, scope === "skip" ? "" : JSON.stringify(scope)]);
  return answer;
}

/** A source name from a project's name: "Union Website" reads as "union-website". */
export const projectSourceName = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
