"use client";

// The old address of the workspace's root page, kept for links and Slack
// installs already in flight: it is /org/workspace now, query and all.

import { useRouter } from "next/navigation";
import { useMountEffect } from "../../hooks/useMountEffect";

export default function AnchorPage() {
  const router = useRouter();
  useMountEffect(() => { router.replace(`/org/workspace${window.location.search}`); });
  return null;
}
