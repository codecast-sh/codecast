// /welcome's email way in: create an account or sign in with an email and a
// password without leaving the page's look for the developer /signup and
// /login. The flow is theirs (hooks/useEmailAuth); only the words and the
// skin are /welcome's. `?email=signup|signin` picks the form, so the back
// button returns to the other ways to sign in. `?email=reset` is a forgotten
// password in the same look: the address, then the mailed code and a new
// password, which signs the person in and carries on.
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router";
import { leaveTo, useEmailAuth, useEmailCode, useResetConfirm, useResetRequest, type EmailAuthFlow } from "../../hooks/useEmailAuth";
import { LANE_PATHS } from "../../components/simple/lanePaths";

export const EMAIL_PARAM = "email";
const FLOWS = { signup: "signUp", signin: "signIn" } as const satisfies Record<string, EmailAuthFlow>;
type FormMode = keyof typeof FLOWS;
export type EmailMode = FormMode | "reset";
export const emailMode = (value: string | null): EmailMode | null => (value === "signup" || value === "signin" || value === "reset" ? value : null);
export const emailStepPath = (mode: EmailMode) => `${LANE_PATHS.welcome}?${EMAIL_PARAM}=${mode}`;

const rise = (i: number) => ({ ["--i" as any]: i }) as CSSProperties;

const WORDS = {
  signup: { title: "Create your account", lede: "An email and a password are all it takes.", go: "Create account", busy: "Creating your account", other: "Already have an account?", otherLink: "Sign in" },
  signin: { title: "Welcome back", lede: "Sign in with your email and password.", go: "Sign in", busy: "Signing in", other: "New here?", otherLink: "Create an account" },
} as const;

export function EmailStep({ mode }: { mode: EmailMode }) {
  return mode === "reset" ? <ResetStep /> : <FormStep mode={mode} />;
}

function FormStep({ mode }: { mode: FormMode }) {
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
        {newPassword ? null : <Link to={emailStepPath("reset")}>Forgot your password?</Link>}
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

/** The ways back from a reset, under either of its forms. */
function ResetFoot({ i, children }: { i: number; children?: ReactNode }) {
  return (
    <p className="wl-aside wl-foot sl-rise" style={rise(i)}>
      {children}
      <Link to={emailStepPath("signin")}>Back to sign in</Link>
      <Link to={LANE_PATHS.welcome}>Other ways to sign in</Link>
    </p>
  );
}

function ResetStep() {
  const ask = useResetRequest();
  if (ask.sent) return <NewPasswordStep email={ask.email} onBack={ask.again} />;
  return (
    <section className="wl-screen" aria-labelledby="wl-reset-title">
      <h1 id="wl-reset-title" className="sl-page-title sl-rise" style={rise(1)}>Forgot your password?</h1>
      <p className="sl-lede sl-rise" style={rise(2)}>Tell us your email and we will send a code to set a new one.</p>
      <form className="wl-form sl-rise" style={rise(3)} onSubmit={ask.submit}>
        <label className="wl-field">
          <span>Email</span>
          <input type="email" name="email" autoComplete="email" required autoFocus value={ask.email} onChange={(e) => ask.setEmail(e.target.value)} placeholder="you@example.com" />
        </label>
        {ask.error ? <p className="sl-callout is-sun wl-error" role="alert">{ask.error}</p> : null}
        <button type="submit" className="sl-btn is-yes wl-connect" disabled={ask.loading}>{ask.loading ? "Sending the code" : "Send the code"}</button>
      </form>
      <ResetFoot i={4} />
    </section>
  );
}

function NewPasswordStep({ email, onBack }: { email: string; onBack: () => void }) {
  const r = useResetConfirm(email, () => leaveTo(LANE_PATHS.welcome));
  return (
    <section className="wl-screen" aria-labelledby="wl-newpw-title">
      <h1 id="wl-newpw-title" className="sl-page-title sl-rise" style={rise(1)}>Set a new password</h1>
      <p className="sl-lede sl-rise" style={rise(2)}>We sent a 6 character code to <b>{email}</b>. Enter it with your new password.</p>
      <form className="wl-form sl-rise" style={rise(3)} onSubmit={r.submit}>
        <label className="wl-field is-code">
          <span>Code</span>
          <input type="text" name="code" autoComplete="one-time-code" required autoFocus maxLength={6} value={r.code} onChange={(e) => r.setCode(e.target.value)} />
        </label>
        <label className="wl-field">
          <span>New password</span>
          <input type="password" name="newPassword" autoComplete="new-password" required minLength={8} value={r.newPassword} onChange={(e) => r.setNewPassword(e.target.value)} placeholder="At least 8 characters" />
        </label>
        <label className="wl-field">
          <span>New password again</span>
          <input type="password" name="confirmPassword" autoComplete="new-password" required value={r.confirmPassword} onChange={(e) => r.setConfirmPassword(e.target.value)} />
        </label>
        {r.error ? <p className="sl-callout is-sun wl-error" role="alert">{r.error}</p> : null}
        <button type="submit" className="sl-btn is-yes wl-connect" disabled={r.loading}>{r.loading ? "Saving" : "Save and sign in"}</button>
      </form>
      <ResetFoot i={4}>
        <span>No email? <button type="button" className="wl-link" onClick={onBack}>Send it again</button></span>
      </ResetFoot>
    </section>
  );
}
