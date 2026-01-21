"use client";
import { useConvexAuth } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const router = useRouter();
  const [authCheckComplete, setAuthCheckComplete] = useState(false);
  const checkCount = useRef(0);

  useEffect(() => {
    if (!isLoading) {
      if (isAuthenticated) {
        setAuthCheckComplete(true);
      } else {
        checkCount.current += 1;
        const delay = checkCount.current === 1 ? 500 : 100;
        const timer = setTimeout(() => setAuthCheckComplete(true), delay);
        return () => clearTimeout(timer);
      }
    }
  }, [isLoading, isAuthenticated]);

  useEffect(() => {
    if (authCheckComplete && !isAuthenticated) {
      router.push("/");
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
