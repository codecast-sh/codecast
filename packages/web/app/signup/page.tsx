import { Suspense } from "react";
import Link from "next/link";
import { useConvexAuth } from "convex/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Logo } from "../../components/Logo";
import { AppLoader } from "../../components/AppLoader";
import { AuthProviderButtons } from "../../components/AuthProviderButtons";
import { EmailVerificationForm } from "../../components/EmailVerificationForm";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useLocalAuth } from "../../lib/localAuth";
import { useEmailAuth } from "../../hooks/useEmailAuth";
import { LANE_PATHS } from "../../components/simple/lanePaths";
import { AssistantWayIn } from "../../components/simple/AssistantWayIn";

function SignUpForm() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTo = searchParams.get("return_to");
  const redirectTo = returnTo ? decodeURIComponent(returnTo) : "/inbox";

  const { email, setEmail, password, setPassword, confirmPassword, setConfirmPassword, error, loading, submit: handleSubmit, pendingVerification, verified, startOver } = useEmailAuth("signUp", redirectTo);

  // Local-first: same instant bounce as the login page for a stored token.
  const localAuthed = useLocalAuth();

  useWatchEffect(() => {
    if (localAuthed || (!isLoading && isAuthenticated)) {
      router.replace(redirectTo);
    }
  }, [localAuthed, isAuthenticated, isLoading, router, redirectTo]);

  if (localAuthed || isLoading || isAuthenticated) {
    return (
<AppLoader />
    );
  }

  if (pendingVerification) {
    return (
      <EmailVerificationForm email={email} onVerified={verified} onBack={startOver} />
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-sol-bg via-sol-bg-alt to-sol-bg flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8 flex flex-col items-center">
          <Logo size="xl" className="text-sol-text" />
          <p className="text-sol-text-muted mt-3 text-sm">
            Create your account
          </p>
        </div>

        {/* The fork for someone who does not write code, before the developer
            form: the hosted assistant's onboarding, which signs them in on its
            own. */}
        {redirectTo !== LANE_PATHS.welcome ? (
          <div className="mb-6 flex justify-center">
            <AssistantWayIn location="signup" tone="app" />
          </div>
        ) : null}

        <div className="bg-sol-bg-alt backdrop-blur-sm border border-sol-border rounded-xl p-8 shadow-xl">
          <AuthProviderButtons verb="up" redirectTo={redirectTo} />

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-sol-border"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-sol-bg-alt text-sol-text-muted">or sign up with email</span>
            </div>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="space-y-5">
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-sol-text-muted mb-2"
              >
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 bg-sol-bg/50 border border-sol-border rounded-lg text-sol-text placeholder-sol-text-dim focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition-all"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-sol-text-muted mb-2"
              >
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 bg-sol-bg/50 border border-sol-border rounded-lg text-sol-text placeholder-sol-text-dim focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition-all"
                placeholder="Create a password"
              />
            </div>

            <div>
              <label
                htmlFor="confirmPassword"
                className="block text-sm font-medium text-sol-text-muted mb-2"
              >
                Confirm Password
              </label>
              <input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-4 py-3 bg-sol-bg/50 border border-sol-border rounded-lg text-sol-text placeholder-sol-text-dim focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition-all"
                placeholder="Confirm your password"
              />
            </div>
          </div>

          {error && (
            <p className="mt-4 text-sm text-red-400 text-center">{error}</p>
          )}

            <button
              type="submit"
              disabled={loading}
              className="w-full mt-6 py-3 px-4 bg-amber-600 hover:bg-amber-500 disabled:bg-amber-600/50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:ring-offset-sol-bg"
            >
              {loading ? "Signing up..." : "Sign Up"}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-sol-text-muted">
            Already have an account?{" "}
            <Link
              href={returnTo ? `/login?return_to=${encodeURIComponent(returnTo)}` : "/login"}
              className="text-amber-400 hover:text-amber-300 font-medium transition-colors"
            >
              Sign In
            </Link>
          </p>
        </div>

      </div>
    </main>
  );
}

export default function SignUpPage() {
  return (
    <Suspense fallback={
<AppLoader />
    }>
      <SignUpForm />
    </Suspense>
  );
}
