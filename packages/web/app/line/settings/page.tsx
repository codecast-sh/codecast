"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useWatchEffect } from "../../../hooks/useWatchEffect";

// /line/settings: the address flow settings had before /flows/settings, its query kept.
export default function LineSettingsRoute() {
  const router = useRouter();
  const search = useSearchParams();
  const q = search?.toString() ?? "";
  const to = `/flows/settings${q ? `?${q}` : ""}`;
  useWatchEffect(() => { router.replace(to); }, [router, to]);
  return null;
}
