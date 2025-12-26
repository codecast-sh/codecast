"use client";
import { useConvexAuth } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const router = useRouter();
  const hasBeenAuthenticated = useRef(false);
  const [authCheckComplete, setAuthCheckComplete] = useState(false);

  if (isAuthenticated) {
    hasBeenAuthenticated.current = true;
  }

  useEffect(() => {
    if (!isLoading) {
      const timer = setTimeout(() => setAuthCheckComplete(true), 100);
      return () => clearTimeout(timer);
    }
  }, [isLoading]);

  useEffect(() => {
    if (authCheckComplete && !isAuthenticated) {
      const reason = hasBeenAuthenticated.current ? "?reason=session_expired" : "";
      router.push(`/login${reason}`);
    }
  }, [authCheckComplete, isAuthenticated, router]);

  if (isLoading || (!isAuthenticated && !authCheckComplete)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-sol-base02">
        <div className="text-sol-base0">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}
