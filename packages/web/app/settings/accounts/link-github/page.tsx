import { useRef } from "react";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { useRouter } from "next/navigation";
import { useConvexAuth } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { AppLoader } from "../../../../components/AppLoader";

export default function LinkGitHubPage() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { signIn } = useAuthActions();
  const router = useRouter();
  const triggeredRef = useRef(false);

  useWatchEffect(() => {
    if (isLoading || triggeredRef.current) return;

    if (!isAuthenticated) {
      router.replace("/login?return_to=/settings/accounts");
      return;
    }

    triggeredRef.current = true;
    signIn("github", { redirectTo: "/settings/accounts" });
  }, [isAuthenticated, isLoading, router, signIn]);

  return <AppLoader label="Redirecting to GitHub..." />;
}
