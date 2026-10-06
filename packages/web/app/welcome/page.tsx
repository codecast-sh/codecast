// /welcome: where someone new to codecast starts (plan pl-840 onboarding,
// docs/architecture/hosted-assistant.md). Three screens: sign in (with its
// email form inline, EmailStep), connect
// mail and calendar, and the first useful thing, which starts a conversation and lands
// in it in the main app in hosted mode. Which screen shows is onboarding.ts welcomeStep;
// a move between screens runs as one view transition (the orb glides, the old
// screen leaves the way the person is heading, the new one rises in order).
//
// Mail and calendar connect through Whisk, the family's mail app, and the
// connect comes back here (convex/whisk.ts WHISK_RETURN_PATHS), so it always
// mounts ConnectNotice, which says how it went. Anyone who acts here
// (connects, skips, or starts) is moved to hosted mode
// (`client_state.ui.lane`).
import { LogoMark } from "../../components/Logo";
import { useState, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ArrowRight, CalendarDays, Check, Mail, ShieldCheck } from "lucide-react";
import type { OAuthProviderId } from "@platform/auth/web";
import { api } from "@codecast/convex/convex/_generated/api";
import { AuthProviderButtons } from "../../components/AuthProviderButtons";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { isDesktopShell } from "../../lib/desktop";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useLocalAuth } from "../../lib/localAuth";
import { useInboxStore } from "../../store/inboxStore";
import { MAIL_COMING, assistantPromise, useConnectAvailable } from "../../components/simple/assistantPromise";
import { Composer } from "../../components/simple/Composer";
import { ConnectNotice } from "../../components/simple/ConnectNotice";
import { calendarAbility, disconnectNote, emailAbility } from "../../components/simple/connectionWords";
import { LaneSync } from "../../components/simple/LaneSync";
import { ASK_FIRST, LANE_COPY, LANE_PATHS, firstAsks, plainConnectError, type MailAbilities } from "../../components/simple/lane";
import { HOSTED_HOME, hostedConversationPath } from "../../components/simple/lanePaths";
import { isHostedUi, writeLane } from "../../components/simple/lanePref";
import { Service } from "../../components/simple/Service";
import { startHostedConversation } from "../../lib/startHostedConversation";
import "../../components/simple/laneLook";
import { useLaneDocumentTitle } from "../../components/simple/useLaneTitle";
import { useLaneMail } from "../../components/simple/useLaneMail";
import { EMAIL_PARAM, EmailStep, emailMode, emailStepPath } from "./EmailStep";
import { SKIP_PARAM, SKIP_VALUE, stepDirection, welcomeStep, welcomeTrail, type WelcomeStep } from "./onboarding";
import "../../components/simple/simple.css";
import "./welcome.css";

/** How long "Connected" stays on screen before the first ask slides in. */
const CONNECTED_PAUSE_MS = 1100;
/** The tapped ask lifts away for this long before the conversation opens. */
const SEND_OFF_MS = 260;

const STEP_NAMES: Record<WelcomeStep, string> = { signin: "Sign in", connect: "Connect", start: "Start" };
/** Connect says what Connections says, so the two screens never disagree. */
const CONNECT_WORDS = LANE_COPY.connections;
const rise = (i: number) => ({ ["--i" as any]: i }) as CSSProperties;

/** Moving to the lane is what arriving through /welcome means, written the
 *  first time the person acts here. */
function joinLane() {
  if (!isHostedUi(useInboxStore.getState().clientState?.ui)) writeLane("simple");
}

/** Runs a screen change as a view transition where the browser has one and
 *  the person has not asked for less motion; otherwise it just swaps. */
function moveTo(from: WelcomeStep, to: WelcomeStep, set: (s: WelcomeStep) => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!doc.startViewTransition || reduce || document.visibilityState !== "visible") {
    set(to);
    return;
  }
  const root = document.documentElement;
  root.dataset.welcomeMove = stepDirection(from, to);
  doc.startViewTransition(() => flushSync(() => set(to))).finished.finally(() => {
    delete root.dataset.welcomeMove;
  });
}

/** The screen on show, which follows `target` through a transition. `hold`
 *  keeps the connect screen up a moment after mail connects, so "Connected"
 *  is seen before the next screen arrives. */
function useShownStep(target: WelcomeStep | null, hold: boolean): WelcomeStep | null {
  const [shown, setShown] = useState<WelcomeStep | null>(target);
  useWatchEffect(() => {
    if (target === null || target === shown) return;
    if (shown === null) {
      setShown(target);
      return;
    }
    const go = () => moveTo(shown, target, setShown);
    if (!(hold && shown === "connect" && target === "start")) {
      go();
      return;
    }
    const timer = window.setTimeout(go, CONNECTED_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [target, shown, hold]);
  return shown;
}

export default function Welcome() {
  useLaneDocumentTitle();
  const signedIn = useLocalAuth();
  return (
    <div data-simple-lane data-welcome>
      {signedIn ? <LaneSync /> : null}
      <div className="sl-frame wl-frame">{signedIn ? <SignedIn /> : <SignedOut />}</div>
    </div>
  );
}

// ── The frame every screen sits in ─────────────────────────────────────────

function Frame({ step, trail, connected = false, children }: { step: WelcomeStep | null; trail: WelcomeStep[]; connected?: boolean; children: ReactNode }) {
  const at = step ? trail.indexOf(step) : -1;
  return (
    <>
      <header className="wl-top">
        {/* The app's own mark and name, as on codecast.sh and in the app; the
            ring is the assistant's, on the stage below. */}
        <span className="sl-brand wl-brand">
          <LogoMark size={20} monochrome className="shrink-0" />
          <span>Codecast</span>
        </span>
        {at >= 0 ? (
          <ol className="wl-rail" aria-label={`Step ${at + 1} of ${trail.length}: ${STEP_NAMES[trail[at]]}`}>
            {trail.map((s, i) => (
              <li key={s} className={i < at ? "is-done" : i === at ? "is-here" : undefined}>
                <span className="wl-rail-name">{STEP_NAMES[s]}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </header>
      <ConnectNotice success={CONNECT_WORDS.success} />
      <main className="wl-stage" data-step={step ?? "loading"}>
        <Orb step={step} connected={connected} />
        {children}
      </main>
    </>
  );
}

/** The assistant's mark, large: it carries across every screen and changes
 *  mood with it (a ripple to say hello, mail and calendar circling in on
 *  connect, a glow once there is something to start). */
function Orb({ step, connected = false }: { step: WelcomeStep | null; connected?: boolean }) {
  return (
    <div className="wl-orb" data-mood={step ?? "loading"} data-connected={connected ? "" : undefined} aria-hidden>
      <span className="wl-orb-core" />
      <span className="wl-orb-moon is-mail"><Mail size={14} strokeWidth={2.2} /></span>
      <span className="wl-orb-moon is-cal"><CalendarDays size={14} strokeWidth={2.2} /></span>
    </div>
  );
}

// ── 1. Sign in ─────────────────────────────────────────────────────────────

function SignedOut() {
  const { available } = useConnectAvailable();
  const [params] = useSearchParams();
  const email = emailMode(params.get(EMAIL_PARAM));
  return (
    <Frame step="signin" trail={welcomeTrail(available)}>
      {/* Mail and calendar are promised only where they can be connected. */}
      {email ? <EmailStep key={email} mode={email} /> : <SignIn mail={available === true} />}
    </Frame>
  );
}

function SignIn({ mail }: { mail: boolean }) {
  const google = useQueryNoThrow(api.auth.signInProviders, {}).data?.google === true;
  // Ordered for someone who does not write code. Google leads when the
  // deployment has it, with the other providers quiet underneath and email
  // as a line. Without it Apple and email are the ways in, and GitHub, which
  // means nothing to this reader, sits quietly last.
  const classFor = (id: OAuthProviderId) =>
    id === "google" ? "wl-auth is-google" : google || id === "github" ? "wl-auth is-quiet" : "wl-auth";
  return (
    <section className="wl-screen" aria-labelledby="wl-signin-title">
      <h1 id="wl-signin-title" className="sl-hello sl-rise" style={rise(1)}>An assistant for the busywork.</h1>
      <p className="sl-lede sl-rise" style={rise(2)}>{assistantPromise(mail)}</p>
      <div className="sl-rise" style={rise(3)}>
        <AuthProviderButtons
          verb="in"
          redirectTo={LANE_PATHS.welcome}
          classFor={classFor}
          labelFor={(id, label) => (google && id !== "google" ? label : `Continue with ${label}`)}
          listClassName={google ? "wl-auth-list has-lead" : "wl-auth-list"}
        >
          {google ? null : (
            <Link to={emailStepPath("signup")} className="wl-auth is-email">
              <Mail size={19} aria-hidden />
              Continue with email
            </Link>
          )}
        </AuthProviderButtons>
      </div>
      <p className="wl-aside sl-rise" style={rise(4)}>
        {google ? (
          <>
            Or use your email: <Link to={emailStepPath("signup")}>create an account</Link>
            {" or "}
            <Link to={emailStepPath("signin")}>sign in</Link>.
          </>
        ) : (
          <>
            Already have an account? <Link to={emailStepPath("signin")}>Sign in with your email</Link>.
          </>
        )}
      </p>
    </section>
  );
}

// ── Signed in: connect, then start ─────────────────────────────────────────

function SignedIn() {
  const [params, setParams] = useSearchParams();
  const skipped = params.get(SKIP_PARAM) === SKIP_VALUE;
  const mail = useLaneMail(LANE_PATHS.welcome);
  const { available } = mail;
  const target = welcomeStep({
    signedIn: true,
    connectAvailable: available,
    connectionsKnown: mail.known,
    connected: mail.connected,
    skipped,
  });
  const shown = useShownStep(target, mail.connected && !skipped);
  const trail = welcomeTrail(available);

  return (
    <Frame step={shown} trail={trail} connected={mail.connected}>
      {shown === "connect" ? (
        <Connect
          mail={mail}
          onSkip={() => {
            joinLane();
            setParams({ [SKIP_PARAM]: SKIP_VALUE });
          }}
        />
      ) : shown === "start" ? (
        <Start
          can={mail.connected ? mail.can : null}
          // "Connect" goes back only for someone who skipped it here.
          onConnect={available !== false && skipped && !mail.connected ? () => setParams({}) : null}
          // Where mail cannot be connected yet, say so once.
          mailComing={available === false}
        />
      ) : (
        <p className="wl-wait" role="status">Getting things ready</p>
      )}
    </Frame>
  );
}

// ── 2. Connect ─────────────────────────────────────────────────────────────

function Connect({ mail, onSkip }: { mail: ReturnType<typeof useLaneMail>; onSkip: () => void }) {
  const { actions, connected, email } = mail;
  // Whisk's approval screen replaces this page and returns to it (the desktop
  // app hands it to the system browser instead), so the line under the
  // buttons says where the person is about to go.
  const [opened, setOpened] = useState(false);
  const error = plainConnectError(actions.error);
  return (
    <section className="wl-screen" aria-labelledby="wl-connect-title">
      <h1 id="wl-connect-title" className="sl-page-title sl-rise" style={rise(1)}>Bring in your mail and calendar</h1>
      <p className="sl-lede sl-rise" style={rise(2)}>One step with Whisk, our mail app, and I can start on your week right away.</p>
      <div className="sl-card wl-services sl-rise" style={rise(3)}>
        <Service icon={<Mail size={19} />} title={CONNECT_WORDS.email}>{emailAbility(null)}</Service>
        <Service icon={<CalendarDays size={19} />} title={CONNECT_WORDS.calendar}>{calendarAbility(null)}</Service>
      </div>
      <p className="wl-promise sl-rise" style={rise(4)}>
        <ShieldCheck size={18} aria-hidden />
        <span>{ASK_FIRST}</span>
      </p>
      {error ? (
        <p className="sl-callout is-sun wl-error" role="alert">{error}</p>
      ) : null}
      <div className="wl-actions sl-rise" style={rise(5)}>
        {connected ? (
          <p className="wl-connected" role="status">
            <span className="wl-connected-tick" aria-hidden><Check size={16} strokeWidth={3} /></span>
            <span>Connected{email ? <> as <b>{email}</b></> : null}</span>
          </p>
        ) : (
          <>
            <button
              type="button"
              className="sl-btn is-yes wl-connect"
              disabled={actions.busy}
              onClick={() => {
                joinLane();
                setOpened(true);
                void actions.connect();
              }}
            >
              {CONNECT_WORDS.connect}
            </button>
            <button type="button" className="sl-btn is-no" onClick={onSkip}>Not now</button>
          </>
        )}
      </div>
      {opened && !connected && !error ? (
        <p className="wl-aside sl-rise" role="status">
          {isDesktopShell() ? CONNECT_WORDS.browserNote : CONNECT_WORDS.leaving}
        </p>
      ) : (
        <p className="wl-aside sl-rise" style={rise(6)}>{disconnectNote(false)}</p>
      )}
    </section>
  );
}

// ── 3. The first useful thing ──────────────────────────────────────────────

function Start({ can, onConnect, mailComing }: { can: MailAbilities | null; onConnect: (() => void) | null; mailComing: boolean }) {
  const navigate = useNavigate();
  const { lead, more } = firstAsks(can);
  const [leaving, setLeaving] = useState<string | null>(null);

  // The conversation's code loads while the person reads, so the landing is instant.
  useMountEffect(() => {
    void import("../conversation/[id]/page");
  });

  const begin = (text: string) => {
    if (leaving) return;
    joinLane();
    const id = startHostedConversation(text);
    setLeaving(text);
    window.setTimeout(() => navigate(hostedConversationPath(id)), SEND_OFF_MS);
  };

  let i = 1;
  return (
    <section className="wl-screen" aria-labelledby="wl-start-title" data-leaving={leaving ? "" : undefined}>
      <h1 id="wl-start-title" className="sl-page-title sl-rise" style={rise(i++)}>
        {lead ? "Let's start with your week" : "What can I take off your plate?"}
      </h1>
      <p className="sl-lede sl-rise" style={rise(i++)}>
        {lead
          ? "Here's a good first thing to ask. Tap it and I'll get going."
          : "Tap one to start, or say it in your own words."}
      </p>
      {mailComing ? <p className="wl-aside wl-coming sl-rise" style={rise(i++)}>{MAIL_COMING}</p> : null}
      {lead ? (
        <button
          type="button"
          className="wl-lead sl-rise"
          style={rise(i++)}
          data-sent={leaving === lead ? "" : undefined}
          onClick={() => begin(lead)}
        >
          <span className="wl-lead-text">{lead}</span>
          <span className="wl-lead-go">
            Ask this <ArrowRight size={17} aria-hidden />
          </span>
        </button>
      ) : null}
      <div className="wl-asks" role="list" aria-label={lead ? "Other things to ask" : "Things to ask"}>
        {more.map((ask) => (
          <button
            key={ask}
            type="button"
            role="listitem"
            className="wl-ask sl-rise"
            style={rise(i++)}
            data-sent={leaving === ask ? "" : undefined}
            onClick={() => begin(ask)}
          >
            <span>{ask}</span>
            <ArrowRight size={16} aria-hidden />
          </button>
        ))}
      </div>
      <div className="wl-own sl-rise" style={rise(i++)}>
        <Composer placeholder="Or ask in your own words" onSend={begin} />
      </div>
      <p className="wl-aside wl-foot sl-rise" style={rise(i++)}>
        {/* One way on: the assistant. Connecting mail shows only while it
            is not connected, and steps back beside it. */}
        <Link
          to={HOSTED_HOME}
          onClick={() => joinLane()}
          className="wl-go"
        >
          Go to my assistant <ArrowRight size={15} aria-hidden />
        </Link>
        {onConnect ? (
          <button type="button" className="wl-link wl-quiet" onClick={onConnect}>Connect your mail and calendar</button>
        ) : null}
      </p>
    </section>
  );
}
