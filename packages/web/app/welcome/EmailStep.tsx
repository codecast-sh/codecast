// /welcome's email way in: create an account or sign in with an email and a
// password without leaving the page's look for the developer /signup and
// /login. The flow is theirs (hooks/useEmailAuth); only the words and the
// skin are /welcome's. `?email=signup|signin` picks the form, so the back
// button returns to the other ways to sign in.
import type { CSSProperties } from "react";
import { Link } from "react-router";
import { useEmailAuth, useEmailCode, type EmailAuthFlow } from "../../hooks/useEmailAuth";
import { LANE_PATHS } from "../../components/simple/lanePaths";

export const EMAIL_PARAM = "email";
const FLOWS = { signup: "signUp", signin: "signIn" } as const satisfies Record<string, EmailAuthFlow>;
export type EmailMode = keyof typeof FLOWS;
export const emailMode = (value: string | null): EmailMode | null => (value === "signup" || value === "signin" ? value : null);
export const emailStepPath = (mode: EmailMode) => `${LANE_PATHS.welcome}?${EMAIL_PARAM}=${mode}`;

const rise = (i: number) => ({ ["--i" as any]: i }) as CSSProperties;

const WORDS = {
  signup: { title: "Create your account", lede: "An email and a password are all it takes.", go: "Create account", busy: "Creating your account", other: "Already have an account?", otherLink: "Sign in" },
  signin: { title: "Welcome back", lede: "Sign in with your email and password.", go: "Sign in", busy: "Signing in", other: "New here?", otherLink: "Create an account" },
} as const;

export function EmailStep({ mode }: { mode: EmailMode }) {
  const auth = useEmailAuth(FLOWS[mode], LANE_PATHS.welcome);
  const w = WORDS[mode];
  if (auth.pendingVerification) return <CodeStep email={auth.email} onVerified={auth.verified} onBack={auth.startOver} />;
  const newPassword = mode === "signup";
  return (
    <section className="wl-screen" aria-labelledby="wl-email-title">
      <h1 id="wl-email-title" className="sl-page-title sl-rise" style={rise(1)}>{w.title}</h1>
      <p className="sl-lede sl-rise" style={rise(2)}>{w.lede}</p>
      <form className="wl-form sl-rise" style={rise(3)} onSubmit={auth.submit}>
        <label className="wl-field">
          <span>Email</span>
          <input type="email" name="email" autoComplete="email" required autoFocus value={auth.email} onChange={(e) => auth.setEmail(e.target.value)} placeholder="you@example.com" />
        </label>
        <label className="wl-field">
          <span>Password</span>
          <input type="password" name="password" autoComplete={newPassword ? "new-password" : "current-password"} required minLength={newPassword ? 8 : undefined} value={auth.password} onChange={(e) => auth.setPassword(e.target.value)} placeholder={newPassword ? "At least 8 characters" : undefined} />
        </label>
        {newPassword ? (
          <label className="wl-field">
            <span>Password again</span>
            <input type="password" name="confirmPassword" autoComplete="new-password" required value={auth.confirmPassword} onChange={(e) => auth.setConfirmPassword(e.target.value)} />
          </label>
        ) : null}
        {auth.error ? <p className="sl-callout is-sun wl-error" role="alert">{auth.error}</p> : null}
        <button type="submit" className="sl-btn is-yes wl-connect" disabled={auth.loading}>{auth.loading ? w.busy : w.go}</button>
      </form>
      <p className="wl-aside wl-foot sl-rise" style={rise(4)}>
        <span>{w.other} <Link to={emailStepPath(newPassword ? "signin" : "signup")}>{w.otherLink}</Link></span>
        {newPassword ? null : <a href="/forgot-password">Forgot your password?</a>}
        <Link to={LANE_PATHS.welcome}>Other ways to sign in</Link>
      </p>
    </section>
  );
}

function CodeStep({ email, onVerified, onBack }: { email: string; onVerified: () => void; onBack: () => void }) {
  const { code, setCode, error, loading, ready, submit } = useEmailCode(email, onVerified);
  return (
    <section className="wl-screen" aria-labelledby="wl-code-title">
      <h1 id="wl-code-title" className="sl-page-title sl-rise" style={rise(1)}>Check your email</h1>
      <p className="sl-lede sl-rise" style={rise(2)}>We sent a 6 character code to <b>{email}</b>. Enter it to confirm your address.</p>
      <form className="wl-form sl-rise" style={rise(3)} onSubmit={submit}>
        <label className="wl-field is-code">
          <span>Code</span>
          <input type="text" name="code" autoComplete="one-time-code" required autoFocus maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
        {error ? <p className="sl-callout is-sun wl-error" role="alert">{error}</p> : null}
        <button type="submit" className="sl-btn is-yes wl-connect" disabled={loading || !ready}>{loading ? "Checking" : "Confirm"}</button>
      </form>
      <p className="wl-aside sl-rise" style={rise(4)}>
        Wrong address? <button type="button" className="wl-link" onClick={onBack}>Start over</button>
      </p>
    </section>
  );
}
