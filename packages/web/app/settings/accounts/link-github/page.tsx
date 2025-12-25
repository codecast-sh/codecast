"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useConvexAuth } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";

export default function LinkGitHubPage() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { signIn } = useAuthActions();
  const router = useRouter();
  const triggeredRef = useRef(false);

  useEffect(() => {
    if (isLoading || triggeredRef.current) return;

    if (!isAuthenticated) {
      router.replace("/login?return_to=/settings/accounts");
      return;
    }

    triggeredRef.current = true;
    signIn("github", { redirectTo: "/settings/accounts" });
  }, [isAuthenticated, isLoading, router, signIn]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-sol-bg">
      <div className="text-center">
        <div className="animate-spin w-8 h-8 border-2 border-sol-cyan border-t-transparent rounded-full mx-auto mb-4" />
        <div className="text-sol-text">Redirecting to GitHub...</div>
      </div>
    </div>
  );
}
