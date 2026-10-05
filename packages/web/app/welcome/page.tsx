// /welcome: where someone new to codecast starts (plan pl-840 onboarding,
// docs/architecture/hosted-assistant.md). Three screens: sign in, connect
// Google, and the first useful thing, which starts a conversation and lands
// in it in the simple lane. Which screen shows is onboarding.ts welcomeStep;
// a move between screens runs as one view transition (the orb glides, the old
// screen leaves the way the person is heading, the new one rises in order).
//
// It is also a page Google's connect returns to (googleOAuth.ts
// GOOGLE_RETURN_PATHS), so it always mounts ConnectNotice, which runs the
// confirm step. Anyone who acts here (connects, skips, or starts) is moved to
// the simple lane (`client_state.ui.lane`).
import { useState, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ArrowRight, ArrowUpRight, CalendarDays, Check, Mail, ShieldCheck } from "lucide-react";
import { oauthProviderButton, type OAuthProviderId } from "@platform/auth/web";
import { api } from "@codecast/convex/convex/_generated/api";
import { AuthProviderButtons, ProviderGlyph } from "../../components/AuthProviderButtons";
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
import { ASK_FIRST, LANE_COPY, LANE_PATHS, conversationPath, firstAsks, plainConnectError, type GoogleAbilities } from "../../components/simple/lane";
import { laneOf, writeLane } from "../../components/simple/lanePref";
import { Service } from "../../components/simple/Service";
import { startConversationWith } from "../../components/simple/startConversation";
import { useLaneFont } from "../../components/simple/useLaneFont";
import { useLaneDocumentTitle } from "../../components/simple/useLaneTitle";
import { useLaneGoogle } from "../../components/simple/useLaneGoogle";
import { SKIP_PARAM, SKIP_VALUE, stepDirection, welcomeStep, welcomeTrail, type WelcomeStep } from "./onboarding";
import "../../components/simple/simple.css";
import "./welcome.css";

/** How long "Connected" stays on screen before the first ask slides in. */
const CONNECTED_PAUSE_MS = 1100;
/** The tapped ask lifts away for this long before the conversation opens. */
const SEND_OFF_MS = 260;

const STEP_NAMES: Record<WelcomeStep, string> = { signin: "Sign in", connect: "Connect", start: "Start" };
const GOOGLE = oauthProviderButton("google");
/** Connect says what Connections says, so the two screens never disagree. */
const CONNECT_WORDS = LANE_COPY.connections;
const rise = (i: number) => ({ ["--i" as any]: i }) as CSSProperties;

/** Whether to offer the connect screen. A backend that cannot answer is
 *  treated as able, so the screen shows and any refusal is said there. */
function useOfferConnect(): boolean | undefined {
  const { available, failed } = useConnectAvailable();
  return failed ? true : available;
}

/** Moving to the lane is what arriving through /welcome means, written the
 *  first time the person acts here. */
function joinLane() {
  if (laneOf(useInboxStore.getState().clientState?.ui) !== "simple") writeLane("simple");
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
 *  keeps the connect screen up a moment after Google connects, so "Connected"
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
  useLaneFont();
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
        <span className="sl-brand">
          <span className="sl-brand-mark" aria-hidden />
          <span>codecast</span>
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
      <ConnectNotice success="Google is connected." />
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
  return (
    <Frame step="signin" trail={welcomeTrail(available)}>
      {/* Mail and calendar are promised only where they can be connected. */}
      <SignIn mail={available === true} />
    </Frame>
  );
}

function SignIn({ mail }: { mail: boolean }) {
  const google = useQueryNoThrow(api.auth.signInProviders, {}).data?.google === true;
  const back = encodeURIComponent(LANE_PATHS.welcome);
  // Google leads when the deployment has it; the other providers then sit
  // quietly underneath. Without it, they are the way in.
  const classFor = (id: OAuthProviderId) =>
    id === "google" ? "wl-auth is-google" : google ? "wl-auth is-quiet" : "wl-auth";
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
        />
      </div>
      <p className="wl-aside sl-rise" style={rise(4)}>
        Or use your email:{" "}
        <Link to={`/signup?return_to=${back}`}>create an account</Link>
        {" or "}
        <Link to={`/login?return_to=${back}`}>sign in</Link>.
      </p>
    </section>
  );
}

// ── Signed in: connect, then start ─────────────────────────────────────────

function SignedIn() {
  const [params, setParams] = useSearchParams();
  const skipped = params.get(SKIP_PARAM) === SKIP_VALUE;
  const available = useOfferConnect();
  const google = useLaneGoogle(LANE_PATHS.welcome);
  const target = welcomeStep({
    signedIn: true,
    connectAvailable: available,
    connectionsKnown: google.known,
    connected: google.connected,
    skipped,
  });
  const shown = useShownStep(target, google.connected && !skipped);
  const trail = welcomeTrail(available);

  return (
    <Frame step={shown} trail={trail} connected={google.connected}>
      {shown === "connect" ? (
        <Connect
          google={google}
          onSkip={() => {
            joinLane();
            setParams({ [SKIP_PARAM]: SKIP_VALUE });
          }}
        />
      ) : shown === "start" ? (
        <Start
          can={google.connected ? google.can : null}
          // "Connect" goes back only for someone who skipped it here.
          onConnect={available !== false && skipped && !google.connected ? () => setParams({}) : null}
          // Where Google cannot be connected yet, say so once.
          mailComing={available === false}
        />
      ) : (
        <p className="wl-wait" role="status">Getting things ready</p>
      )}
    </Frame>
  );
}

// ── 2. Connect ─────────────────────────────────────────────────────────────

function Connect({ google, onSkip }: { google: ReturnType<typeof useLaneGoogle>; onSkip: () => void }) {
  const { actions, connected, email } = google;
  // Google's consent screen replaces this page and returns to it (the desktop
  // app hands it to the system browser instead), so the line under the
  // buttons says where the person is about to go.
  const [opened, setOpened] = useState(false);
  const error = plainConnectError(actions.error);
  return (
    <section className="wl-screen" aria-labelledby="wl-connect-title">
      <h1 id="wl-connect-title" className="sl-page-title sl-rise" style={rise(1)}>Bring in your mail and calendar</h1>
      <p className="sl-lede sl-rise" style={rise(2)}>One step with Google, and I can start on your week right away.</p>
      <div className="sl-card wl-services sl-rise" style={rise(3)}>
        <Service icon={<Mail size={19} />} title={CONNECT_WORDS.email}>{emailAbility(null)}</Service>
        <Service icon={<CalendarDays size={19} />} title={CONNECT_WORDS.calendar}>{calendarAbility(null)}</Service>
      </div>
      <p className="wl-promise sl-rise" style={rise(4)}>
        <ShieldCheck size={18} aria-hidden />
        <span>{ASK_FIRST} Nothing goes out without your yes.</span>
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
              {GOOGLE ? <span className="wl-g" aria-hidden><ProviderGlyph button={GOOGLE} className="wl-g-mark" /></span> : null}
              {CONNECT_WORDS.connect}
            </button>
            <button type="button" className="sl-btn is-no" onClick={onSkip}>Not now</button>
          </>
        )}
      </div>
      {opened && !connected && !error ? (
        <p className="wl-aside sl-rise" role="status">
          {isDesktopShell() ? CONNECT_WORDS.browserNote : "Taking you to Google. You'll come straight back here."}
        </p>
      ) : (
        <p className="wl-aside sl-rise" style={rise(6)}>{disconnectNote(false, undefined, [])}</p>
      )}
    </section>
  );
}

// ── 3. The first useful thing ──────────────────────────────────────────────

function Start({ can, onConnect, mailComing }: { can: GoogleAbilities | null; onConnect: (() => void) | null; mailComing: boolean }) {
  const navigate = useNavigate();
  const { lead, more } = firstAsks(can);
  const [leaving, setLeaving] = useState<string | null>(null);

  // The conversation's code loads while the person reads, so the landing is instant.
  useMountEffect(() => {
    void import("../../src/layouts/SimpleShell");
    void import("../simple/c/[id]/page");
  });

  const begin = (text: string) => {
    if (leaving) return;
    joinLane();
    const id = startConversationWith(text);
    setLeaving(text);
    window.setTimeout(() => navigate(conversationPath(id)), SEND_OFF_MS);
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
            <ArrowUpRight size={16} aria-hidden />
          </button>
        ))}
      </div>
      <div className="wl-own sl-rise" style={rise(i++)}>
        <Composer placeholder="Or ask in your own words" onSend={begin} />
      </div>
      <p className="wl-aside wl-foot sl-rise" style={rise(i++)}>
        {onConnect ? (
          <>
            <button type="button" className="wl-link" onClick={onConnect}>Connect your mail and calendar</button>
          </>
        ) : null}
        <Link
          to={LANE_PATHS.home}
          onClick={() => joinLane()}
        >
          Go to my assistant
        </Link>
      </p>
    </section>
  );
}
