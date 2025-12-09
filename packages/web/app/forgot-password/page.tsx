"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuthActions } from "@convex-dev/auth/react";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const { signIn } = useAuthActions();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      await signIn("password", { email, flow: "reset" });
      setSuccess(true);
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes("not found")) {
          setError("No account found with this email.");
        } else {
          setError("Failed to send reset code. Please try again.");
        }
      } else {
        setError("An unexpected error occurred.");
      }
    } finally {
      setLoading(false);
    }
  };

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
            <Link
              href={`/reset-password?email=${encodeURIComponent(email)}`}
              className="inline-block w-full py-3 px-4 bg-amber-600 hover:bg-amber-500 text-white font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:ring-offset-sol-bg"
            >
              Enter Reset Code
            </Link>
            <p className="mt-6 text-sm text-sol-text-muted">
              Didn&apos;t receive the email?{" "}
              <button
                onClick={() => setSuccess(false)}
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

          <button
            type="submit"
            disabled={loading}
            className="w-full mt-6 py-3 px-4 bg-amber-600 hover:bg-amber-500 disabled:bg-amber-600/50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:ring-offset-sol-bg"
          >
            {loading ? "Sending..." : "Send Reset Code"}
          </button>

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
