import { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMountEffect } from "../hooks/useMountEffect";

function RedirectToHome() {
  const router = useRouter();
  useMountEffect(() => { router.push("/"); });
  return null;
}

function AuthGuardInner({ children, guestOk }: { children: React.ReactNode; guestOk?: boolean }) {
  return (
    <>
      <AuthLoading>
        <div className="min-h-screen flex items-center justify-center bg-sol-base02">
          <div className="text-sol-base0">Loading...</div>
        </div>
      </AuthLoading>
      <Unauthenticated>
        {guestOk ? children : <RedirectToHome />}
      </Unauthenticated>
      <Authenticated>
        {children}
      </Authenticated>
    </>
  );
}

let hasHydrated = false;

/**
 * guestOk: render children for unauthenticated visitors instead of redirecting
 * home — for routes that do their own access resolution (public share links).
 * The auth-loading holding screen still applies either way.
 */
export function AuthGuard({ children, guestOk }: { children: React.ReactNode; guestOk?: boolean }) {
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

  return <AuthGuardInner guestOk={guestOk}>{children}</AuthGuardInner>;
}
