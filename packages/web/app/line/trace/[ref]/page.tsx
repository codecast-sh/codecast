"use client";
import { useParams, useRouter } from "next/navigation";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { lineRefHref, lineRefOf } from "../../../../lib/line/lineWorkspaceUrl";

// /line/trace/<ref>: the address a ref's trace had before /flows/trace/<ref>.
export default function LineTraceRoute() {
  const { ref } = useParams<{ ref: string }>();
  const router = useRouter();
  const to = lineRefHref(lineRefOf(ref ?? ""));
  useWatchEffect(() => { router.replace(to); }, [router, to]);
  return null;
}
