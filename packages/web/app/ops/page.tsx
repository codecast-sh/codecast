"use client";
// /ops and everything under it: the Ops views live under the flows app's
// Signals stage now (doc "Signals to shipped: one pipeline"). Each old address
// goes to the same view there (opsPaths opsViewHref); bare /ops opens Signals.
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { opsViewHref, parseOpsPath } from "../../components/ops/opsPaths";

export default function OpsRedirect() {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const query = search?.toString() ?? "";
  const bare = !query && /^\/ops\/?$/.test(pathname ?? "");
  const to = bare ? "/flows?view=signals" : opsViewHref(parseOpsPath(pathname, query));
  useWatchEffect(() => { router.replace(to); }, [router, to]);
  return null;
}
