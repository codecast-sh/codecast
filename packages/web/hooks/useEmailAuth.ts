// Email and password sign-in and sign-up, as state and handlers with no
// markup, so /login, /signup and /welcome's email step run the same flow in
// their own look. When the backend requires email verification (the Password
// provider's `verify` option), signIn resolves `signingIn: false` after
// mailing a code; `pendingVerification` then asks the surface for the code
// step (useEmailCode). A forgotten password is the same shape in two steps:
// useResetRequest mails a code, useResetConfirm trades it and a new password
// for a signed-in session.
import { useState, type FormEvent } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";

export type EmailAuthFlow = "signIn" | "signUp";

/** What a failed attempt says, in words a person can act on. */
function failure(flow: EmailAuthFlow, err: unknown): string {
  if (!(err instanceof Error)) return "An unexpected error occurred.";
  const m = err.message;
  if (flow === "signUp") {
    if (m.includes("already") || m.includes("exists") || m.includes("registered")) return "Email already registered";
    if (m.includes("password")) return "Password must be at least 8 characters";
    return "Sign up failed. Please try again.";
  }
  if (m.includes("Invalid") || m.includes("credentials")) return "Invalid email or password. Please try again.";
  if (m.includes("not found")) return "No account found with this email.";
  return "Sign in failed. Please try again.";
}

/** Leaves by a full load, so the signed-in app boots from a clean slate. */
export const leaveTo = (redirectTo: string) => {
  window.location.href = redirectTo;
};

export function useEmailAuth(flow: EmailAuthFlow, redirectTo: string) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [pendingVerification, setPendingVerification] = useState(false);
  const { signIn } = useAuthActions();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (flow === "signUp" && password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await signIn("password", { email, password, flow });
      if (result && result.signingIn === false) {
        setPendingVerification(true);
        setLoading(false);
        return;
      }
      leaveTo(redirectTo);
    } catch (err) {
      setError(failure(flow, err));
      setLoading(false);
    }
  };

  return {
    email, setEmail, password, setPassword, confirmPassword, setConfirmPassword,
    error, loading, submit,
    pendingVerification,
    /** The code was accepted: on to the app. */
    verified: () => leaveTo(redirectTo),
    /** Wrong address: back to the form. */
    startOver: () => setPendingVerification(false),
  };
}

/** The "enter the code we emailed you" step that completes either flow. */
export function useEmailCode(email: string, onVerified: () => void) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { signIn } = useAuthActions();

  const submit = async (e: FormEvent) => {
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

  return { code, setCode: (v: string) => setCode(v.toUpperCase()), error, loading, ready: code.trim().length >= 6, submit };
}

/** Step one of a forgotten password: mail a reset code to the address. */
export function useResetRequest(initialEmail = "") {
  const [email, setEmail] = useState(initialEmail);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const { signIn } = useAuthActions();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await signIn("password", { email, flow: "reset" });
      setSent(true);
    } catch (err) {
      setError(
        !(err instanceof Error) ? "An unexpected error occurred."
          : err.message.includes("not found") ? "No account found with this email."
            : "Failed to send reset code. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  };

  return { email, setEmail, error, loading, sent, submit, /** No mail arrived: back to the address. */ again: () => setSent(false) };
}

/** Step two: the mailed code and a new password. Accepting them signs the
 *  person in, so `onDone` runs signed in. */
export function useResetConfirm(email: string, onDone: () => void) {
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { signIn } = useAuthActions();
  const notifyPasswordChanged = useMutation(api.emails.send.notifyPasswordChanged);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setLoading(true);
    try {
      await signIn("password", { email, code, newPassword, flow: "reset-verification" });
      // Security notice to the account's inbox. The reset just signed us in,
      // so the authenticated mutation targets our own address. Best effort:
      // never block the redirect on it.
      notifyPasswordChanged({}).catch(() => {});
      onDone();
    } catch (err) {
      setError(
        !(err instanceof Error) ? "An unexpected error occurred."
          : err.message.includes("Invalid") || err.message.includes("code") ? "Invalid or expired reset code. Please try again."
            : "Failed to reset password. Please try again.",
      );
      setLoading(false);
    }
  };

  return {
    code, setCode: (v: string) => setCode(v.toUpperCase()),
    newPassword, setNewPassword, confirmPassword, setConfirmPassword,
    error, loading, submit,
  };
}
