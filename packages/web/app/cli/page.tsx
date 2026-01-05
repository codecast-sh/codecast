"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function CliPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/settings/cli");
  }, [router]);

  return null;
}
