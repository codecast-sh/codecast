import { Suspense } from "react";
import Link from "next/link";
import { useResetConfirm } from "../../hooks/useEmailAuth";
import { useRouter, useSearchParams } from "next/navigation";
import { AppLoader } from "../../components/AppLoader";

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const email = searchParams.get("email") || "";
  const router = useRouter();
  const { code, setCode, newPassword, setNewPassword, confirmPassword, setConfirmPassword, error, loading, submit: handleSubmit } =
    useResetConfirm(email, () => router.push("/login?reset=success"));

  return (
    <main className="min-h-screen bg-gradient-to-br from-sol-bg via-sol-bg-alt to-sol-bg flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-semibold text-sol-text tracking-tight">
            Reset your password
          </h1>
          <p className="text-sol-text-muted mt-2 text-sm">
            Enter the code sent to <span className="font-medium text-sol-text">{email}</span>
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-sol-bg-alt/50 backdrop-blur border border-sol-border rounded-xl p-8 shadow-2xl"
        >
          <div className="space-y-5">
            <div>
              <label
                htmlFor="code"
                className="block text-sm font-medium text-sol-text-muted mb-2"
              >
                Reset Code
              </label>
              <input
                id="code"
                name="code"
                type="text"
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="sol-input w-full py-3 font-mono tracking-widest text-center text-lg"
                placeholder="XXXXXX"
                maxLength={6}
              />
            </div>

            <div>
              <label
                htmlFor="newPassword"
                className="block text-sm font-medium text-sol-text-muted mb-2"
              >
                New Password
              </label>
              <input
                id="newPassword"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                required
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="sol-input w-full py-3"
                placeholder="At least 8 characters"
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
                className="sol-input w-full py-3"
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
            {loading ? "Resetting..." : "Reset Password"}
          </button>

          <p className="mt-6 text-center text-sm text-sol-text-muted">
            Need a new code?{" "}
            <Link
              href="/forgot-password"
              className="text-amber-400 hover:text-amber-300 font-medium transition-colors"
            >
              Request again
            </Link>
          </p>
        </form>
      </div>
    </main>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
<AppLoader />
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}
