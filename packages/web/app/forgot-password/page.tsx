import Link from "next/link";
import { useResetRequest } from "../../hooks/useEmailAuth";
import { Button } from "../../components/ui/button";

export default function ForgotPasswordPage() {
  const { email, setEmail, error, loading, sent: success, submit: handleSubmit, again } = useResetRequest();

  if (success) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-sol-bg via-sol-bg-alt to-sol-bg flex items-center justify-center px-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-semibold text-sol-text tracking-tight">
              Check your email
            </h1>
            <p className="text-sol-text-muted mt-2 text-sm">
              We sent a reset code to {email}
            </p>
          </div>

          <div className="bg-sol-bg-alt/50 backdrop-blur border border-sol-border rounded-xl p-8 shadow-2xl text-center">
            <p className="text-sol-text-muted mb-6">
              Enter the code from your email to reset your password.
            </p>
            <Button asChild variant="amber" size="lg" className="w-full">
              <Link href={`/reset-password?email=${encodeURIComponent(email)}`}>Enter Reset Code</Link>
            </Button>
            <p className="mt-6 text-sm text-sol-text-muted">
              Didn&apos;t receive the email?{" "}
              <button
                onClick={again}
                className="text-amber-400 hover:text-amber-300 font-medium transition-colors"
              >
                Try again
              </button>
            </p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-sol-bg via-sol-bg-alt to-sol-bg flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-semibold text-sol-text tracking-tight">
            Forgot password?
          </h1>
          <p className="text-sol-text-muted mt-2 text-sm">
            Enter your email and we&apos;ll send you a reset code
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-sol-bg-alt/50 backdrop-blur border border-sol-border rounded-xl p-8 shadow-2xl"
        >
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
              className="sol-input w-full py-3"
              placeholder="you@example.com"
            />
          </div>

          {error && (
            <p className="mt-4 text-sm text-red-400 text-center">{error}</p>
          )}

          <Button
            variant="amber"
            size="lg"
            type="submit"
            disabled={loading}
            className="mt-6 w-full"
          >
            {loading ? "Sending..." : "Send Reset Code"}
          </Button>

          <p className="mt-6 text-center text-sm text-sol-text-muted">
            Remember your password?{" "}
            <Link
              href="/login"
              className="text-amber-400 hover:text-amber-300 font-medium transition-colors"
            >
              Sign In
            </Link>
          </p>
        </form>
      </div>
    </main>
  );
}
