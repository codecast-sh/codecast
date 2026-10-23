"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { flowsAddressOf, lineWorkspaceRedirect } from "../../lib/line/lineWorkspaceUrl";

// /line: the address the flows app had before /flows. It goes to /flows with
// what it named kept: an old map address where that now lives, any other at the
// same view (Decisions when it named none, the landing page then).
export default function LineRoute() {
  const router = useRouter();
  const search = useSearchParams();
  const to = lineWorkspaceRedirect(search) ?? `/flows${flowsAddressOf(search)}`;
  useWatchEffect(() => { router.replace(to); }, [router, to]);
  return null;
}
