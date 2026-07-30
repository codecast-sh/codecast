import { useState, Suspense } from "react";
import Link from "next/link";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth } from "convex/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Logo } from "../../components/Logo";
import { AppLoader } from "../../components/AppLoader";
import { AuthProviderButtons } from "../../components/AuthProviderButtons";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useLocalAuth } from "../../lib/localAuth";

function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const { signIn } = useAuthActions();
  const { isAuthenticated, isLoading } = useConvexAuth();
  // Local-first: an already-signed-in visitor (token in storage) bounces to
  // the app immediately — no waiting on the server handshake, which offline
  // would pin this page on the loader forever.
  const localAuthed = useLocalAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const reason = searchParams.get("reason");
  const returnTo = searchParams.get("return_to");
  const redirectTo = returnTo || "/inbox";

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      await signIn("password", { email, password, flow: "signIn" });
      window.location.href = redirectTo;
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes("Invalid") || err.message.includes("credentials")) {
          setError("Invalid email or password. Please try again.");
        } else if (err.message.includes("not found")) {
          setError("No account found with this email.");
        } else {
          setError("Sign in failed. Please try again.");
        }
      } else {
        setError("An unexpected error occurred.");
      }
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-sol-bg via-sol-bg-alt to-sol-bg flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8 flex flex-col items-center">
          <Logo size="xl" className="text-sol-text" />
          <p className="text-sol-text-muted mt-3 text-sm">
            {reason === "session_expired"
              ? "Your session expired. Please sign in again."
              : "Sign in to access your conversations"}
          </p>
        </div>

        <div className="bg-sol-bg-alt backdrop-blur-sm border border-sol-border rounded-xl p-8 shadow-xl">
          <AuthProviderButtons verb="in" redirectTo={redirectTo} />

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-sol-border"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-sol-bg-alt text-sol-text-muted">or sign in with email</span>
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
              <div className="flex items-center justify-between mb-2">
                <label
                  htmlFor="password"
                  className="block text-sm font-medium text-sol-text-muted"
                >
                  Password
                </label>
                <Link
                  href="/forgot-password"
                  tabIndex={-1}
                  className="text-sm text-amber-400 hover:text-amber-300 transition-colors"
                >
                  Forgot password?
                </Link>
              </div>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 bg-sol-bg/50 border border-sol-border rounded-lg text-sol-text placeholder-sol-text-dim focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition-all"
                placeholder="Enter your password"
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
              {loading ? "Signing in..." : "Sign In"}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-sol-text-muted">
            Don&apos;t have an account?{" "}
            <Link
              href={returnTo ? `/signup?return_to=${encodeURIComponent(returnTo)}` : "/signup"}
              className="text-amber-400 hover:text-amber-300 font-medium transition-colors"
            >
              Sign Up
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
<AppLoader />
    }>
      <LoginForm />
    </Suspense>
  );
}
