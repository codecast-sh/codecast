import { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

function RedirectToHome() {
  const router = useRouter();
  useEffect(() => {
    router.push("/");
  }, [router]);
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

  useEffect(() => {
    hasHydrated = true;
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-sol-base02">
        <div className="text-sol-base0">Loading...</div>
      </div>
    );
  }

  return <AuthGuardInner>{children}</AuthGuardInner>;
}
