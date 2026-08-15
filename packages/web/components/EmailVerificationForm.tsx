import { useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { Logo } from "./Logo";

/**
 * The "enter the code we emailed you" step of password sign-up / sign-in.
 *
 * Shown when the backend requires email verification (Password provider's
 * `verify` option): `signIn(..., { flow: "signUp" | "signIn" })` resolves with
 * `signingIn: false` after emailing an OTP, and this form completes the flow
 * with `flow: "email-verification"`. Styled to match the auth cards.
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
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { signIn } = useAuthActions();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await signIn("password", { email, code: code.trim(), flow: "email-verification" });
      onVerified();
    } catch {
      setError("Invalid or expired code. Check the email and try again.");
      setLoading(false);
    }
  };

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
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            className="w-full px-4 py-3 bg-sol-bg/50 border border-sol-border rounded-lg text-sol-text placeholder-sol-text-dim font-mono tracking-[0.5em] text-center text-lg focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition-all"
            placeholder="XXXXXX"
          />

          {error && <p className="mt-4 text-sm text-red-400 text-center">{error}</p>}

          <button
            type="submit"
            disabled={loading || code.trim().length < 6}
            className="w-full mt-6 py-3 px-4 bg-amber-600 hover:bg-amber-500 disabled:bg-amber-600/50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:ring-offset-sol-bg"
          >
            {loading ? "Verifying..." : "Verify Email"}
          </button>

          <p className="mt-6 text-center text-sm text-sol-text-muted">
            Wrong address?{" "}
            <button
              type="button"
              onClick={onBack}
              className="text-amber-400 hover:text-amber-300 font-medium transition-colors"
            >
              Start over
            </button>
          </p>
        </form>
      </div>
    </main>
  );
}
