import { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMountEffect } from "../hooks/useMountEffect";

function RedirectToHome() {
  const router = useRouter();
  useMountEffect(() => { router.push("/"); });
  return null;
}

function AuthGuardInner({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AuthLoading>
        <div className="min-h-screen flex items-center justify-center bg-sol-base02">
          <div className="text-sol-base0">Loading...</div>
        </div>
      </AuthLoading>
      <Unauthenticated>
        <RedirectToHome />
      </Unauthenticated>
      <Authenticated>
        {children}
      </Authenticated>
    </>
  );
}

let hasHydrated = false;

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(hasHydrated);

  useMountEffect(() => {
    hasHydrated = true;
    setMounted(true);
  });

  if (!mounted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-sol-base02">
        <div className="text-sol-base0">Loading...</div>
      </div>
    );
  }

  return <AuthGuardInner>{children}</AuthGuardInner>;
}
