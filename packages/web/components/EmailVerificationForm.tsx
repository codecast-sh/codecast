import { useEmailCode } from "../hooks/useEmailAuth";
import { Logo } from "./Logo";
import { Button } from "./ui/button";

/**
 * The "enter the code we emailed you" step of password sign-up / sign-in.
 *
 * Shown when the backend requires email verification (Password provider's
 * `verify` option): `signIn(..., { flow: "signUp" | "signIn" })` resolves with
 * `signingIn: false` after emailing an OTP, and this form completes the flow
 * with `flow: "email-verification"` (useEmailCode). Styled to match the auth
 * cards; /welcome draws the same step in its own look.
 */
export function EmailVerificationForm({
  email,
  onVerified,
  onBack,
}: {
  email: string;
  onVerified: () => void;
  onBack: () => void;
}) {
  const { code, setCode, error, loading, ready, submit: handleSubmit } = useEmailCode(email, onVerified);

  return (
    <main className="min-h-screen bg-gradient-to-br from-sol-bg via-sol-bg-alt to-sol-bg flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8 flex flex-col items-center">
          <Logo size="xl" className="text-sol-text" />
          <p className="text-sol-text-muted mt-3 text-sm">Check your email</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-sol-bg-alt backdrop-blur-sm border border-sol-border rounded-xl p-8 shadow-xl"
        >
          <p className="text-sm text-sol-text-muted mb-6 text-center">
            We sent a 6-character code to{" "}
            <span className="font-medium text-sol-text">{email}</span>. Enter it to
            confirm your address.
          </p>

          <label
            htmlFor="verification-code"
            className="block text-sm font-medium text-sol-text-muted mb-2"
          >
            Verification Code
          </label>
          <input
            id="verification-code"
            name="code"
            type="text"
            inputMode="text"
            autoComplete="one-time-code"
            autoFocus
            required
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-full px-4 py-3 bg-sol-bg/50 border border-sol-border rounded-lg text-sol-text placeholder-sol-text-dim font-mono tracking-[0.5em] text-center text-lg focus:outline-none focus:ring-2 focus:ring-sol-cyan/50 focus:border-transparent transition-all"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "auth-error" : undefined}
            placeholder="XXXXXX"
          />

          {error && <p id="auth-error" role="alert" className="mt-4 rounded-md border border-sol-red/40 bg-sol-red/10 px-3 py-2 text-sm text-sol-text text-center">{error}</p>}

          <Button
            variant="amber"
            size="lg"
            type="submit"
            disabled={loading || !ready}
            className="mt-6 w-full"
          >
            {loading ? "Verifying..." : "Verify Email"}
          </Button>

          <p className="mt-6 text-center text-sm text-sol-text-muted">
            Wrong address?{" "}
            <button
              type="button"
              onClick={onBack}
              className="font-medium text-sol-text-secondary underline decoration-sol-orange/70 underline-offset-2 hover:text-sol-text hover:decoration-sol-orange transition-colors"
            >
              Start over
            </button>
          </p>
        </form>
      </div>
    </main>
  );
}
