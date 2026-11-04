"use client";
// /ops and everything under it: the Ops area (components/ops/OpsArea.tsx).
// The address is the view (components/ops/opsPaths.ts parseOpsPath); the data
// is the workspace the app's switcher has active.
import { useMemo } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { AuthGuard } from "../../components/AuthGuard";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { OpsArea } from "../../components/ops/OpsArea";
import { parseOpsPath } from "../../components/ops/opsPaths";

export default function OpsRoute() {
  const pathname = usePathname();
  const search = useSearchParams();
  const query = search?.toString() ?? "";
  const view = useMemo(() => parseOpsPath(pathname, query), [pathname, query]);
  return (
    <AuthGuard>
      <ErrorBoundary name="Ops">
        <OpsArea view={view} />
      </ErrorBoundary>
    </AuthGuard>
  );
}
