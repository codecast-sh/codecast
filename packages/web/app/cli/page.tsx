"use client";

import { useRouter } from "next/navigation";
import { useWatchEffect } from "../../hooks/useWatchEffect";

export default function CliPage() {
  const router = useRouter();

  useWatchEffect(() => {
    router.replace("/settings/cli");
  }, [router]);

  return null;
}
