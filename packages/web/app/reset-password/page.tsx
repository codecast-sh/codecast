import { Suspense } from "react";
import Link from "next/link";
import { useResetConfirm } from "../../hooks/useEmailAuth";
import { useRouter, useSearchParams } from "next/navigation";
import { AppLoader } from "../../components/AppLoader";
import { Button } from "../../components/ui/button";

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
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "auth-error" : undefined}
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
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "auth-error" : undefined}
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
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "auth-error" : undefined}
                placeholder="Confirm your password"
              />
            </div>
          </div>

          {error && (
            <p id="auth-error" role="alert" className="mt-4 rounded-md border border-sol-red/40 bg-sol-red/10 px-3 py-2 text-sm text-sol-text text-center">{error}</p>
          )}

          <Button
            variant="amber"
            size="lg"
            type="submit"
            disabled={loading}
            className="mt-6 w-full"
          >
            {loading ? "Resetting..." : "Reset Password"}
          </Button>

          <p className="mt-6 text-center text-sm text-sol-text-muted">
            Need a new code?{" "}
            <Link
              href="/forgot-password"
              className="font-medium text-sol-text-secondary underline decoration-sol-orange/70 underline-offset-2 hover:text-sol-text hover:decoration-sol-orange transition-colors"
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
