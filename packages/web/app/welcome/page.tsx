// /welcome: where someone new to codecast starts (plan pl-840 onboarding,
// docs/architecture/hosted-assistant.md). Two steps: sign in (with its email
// form inline, EmailStep), then the first useful thing, which starts a
// conversation and lands in it in the main app in hosted mode. Connecting mail
// and calendar is a side screen opened from Start, so nobody meets an outside
// consent screen before seeing an answer. Which screen shows is onboarding.ts welcomeStep;
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
import { ASSISTANT_HEADLINE, MAIL_COMING, THINKING_DOWN, assistantPromise, useConnectAvailable, useThinkingAvailable } from "../../components/simple/assistantPromise";
import { Composer } from "../../components/simple/Composer";
import { ConnectNotice } from "../../components/simple/ConnectNotice";
import { calendarAbility, disconnectNote, emailAbility } from "../../components/simple/connectionWords";
import { LaneSync } from "../../components/simple/LaneSync";
import { ASK_FIRST, LANE_COPY, LANE_PATHS, firstAsks, plainConnectError, type MailAbilities } from "../../components/simple/lane";
import { HOSTED_HOME, WELCOME_ASK_PARAM, hostedConversationPath } from "../../components/simple/lanePaths";
import { isHostedUi, writeLane } from "../../components/simple/lanePref";
import { Service } from "../../components/simple/Service";
import { startHostedConversation } from "../../lib/startHostedConversation";
import "../../components/simple/laneLook";
import { useLaneDocumentTitle } from "../../components/simple/useLaneTitle";
import { useLaneMail } from "../../components/simple/useLaneMail";
import { EMAIL_PARAM, EmailStep, emailMode, emailStepPath } from "./EmailStep";
import { CONNECT_VALUE, STEP_PARAM, WELCOME_TRAIL, stepDirection, trailStep, welcomeStep, type WelcomeStep } from "./onboarding";
import { WHISK_GLYPH, WhiskWordmark } from "../../components/simple/WhiskWordmark";
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

function Frame({ step, connected = false, children }: { step: WelcomeStep | null; connected?: boolean; children: ReactNode }) {
  const trail = WELCOME_TRAIL;
  // The rail names every step while the page loads, with none marked yet.
  const at = step ? trail.indexOf(trailStep(step)) : -1;
  return (
    <>
      <header className="wl-top">
        {/* The app's own mark and name, as on codecast.sh and in the app; the
            ring is the assistant's, on the stage below. */}
        <span className="sl-brand wl-brand">
          <LogoMark size={20} monochrome className="shrink-0" />
          <span>Codecast</span>
        </span>
        <ol className="wl-rail" aria-label={at >= 0 ? `Step ${at + 1} of ${trail.length}: ${STEP_NAMES[trail[at]]}` : `${trail.length} steps`}>
          {trail.map((s, i) => (
            <li key={s} className={at < 0 ? undefined : i < at ? "is-done" : i === at ? "is-here" : undefined}>
              <span className="wl-rail-name">{STEP_NAMES[s]}</span>
            </li>
          ))}
        </ol>
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
      <span className="wl-orb-core"><LogoMark monochrome /></span>
      <span className="wl-orb-moon is-mail"><Mail size={14} strokeWidth={2.2} /></span>
      <span className="wl-orb-moon is-cal"><CalendarDays size={14} strokeWidth={2.2} /></span>
    </div>
  );
}

// ── The errand carried in from the marketing page ──────────────────────────

const CARRIED_ASK_KEY = "codecast-welcome-ask";
/** Longer than any ask the marketing page links, short enough to refuse a
 *  pasted essay in a crafted link. */
const CARRIED_ASK_MAX = 300;

function keepCarriedAsk(ask: string | null) {
  const text = ask?.trim();
  if (!text || text.length > CARRIED_ASK_MAX) return;
  try { sessionStorage.setItem(CARRIED_ASK_KEY, text); } catch {}
}

/** The errand from `?ask=` or kept across sign-in, or null. Read once, when
 *  Start shows. */
function takeCarriedAsk(): string | null {
  keepCarriedAsk(new URLSearchParams(window.location.search).get(WELCOME_ASK_PARAM));
  try { return sessionStorage.getItem(CARRIED_ASK_KEY); } catch { return null; }
}

function forgetCarriedAsk() {
  try { sessionStorage.removeItem(CARRIED_ASK_KEY); } catch {}
}

// ── 1. Sign in ─────────────────────────────────────────────────────────────

function SignedOut() {
  const { available } = useConnectAvailable();
  const [params] = useSearchParams();
  // A sign-in leaves the page and comes back to /welcome: the errand the
  // person picked on the marketing page rides along in this tab's storage.
  useMountEffect(() => { keepCarriedAsk(params.get(WELCOME_ASK_PARAM)); });
  const email = emailMode(params.get(EMAIL_PARAM));
  return (
    <Frame step="signin">
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
      <h1 id="wl-signin-title" className="sl-hello sl-rise" style={rise(1)}>{ASSISTANT_HEADLINE}</h1>
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

// ── Signed in: start, with connect beside it ───────────────────────────────

function SignedIn() {
  const [params, setParams] = useSearchParams();
  const connecting = params.get(STEP_PARAM) === CONNECT_VALUE;
  const mail = useLaneMail(LANE_PATHS.welcome);
  const { available } = mail;
  const target = welcomeStep({
    signedIn: true,
    connectAvailable: available,
    connectionsKnown: mail.known,
    connected: mail.connected,
    connecting,
  });
  const shown = useShownStep(target, mail.connected);

  return (
    <Frame step={shown} connected={mail.connected}>
      {shown === "connect" ? (
        <Connect
          mail={mail}
          onSkip={() => {
            joinLane();
            setParams({});
          }}
        />
      ) : shown === "start" ? (
        <Start
          can={mail.connected ? mail.can : null}
          // Connect is offered only where the deployment has said it works.
          onConnect={available === true && !mail.connected ? () => setParams({ [STEP_PARAM]: CONNECT_VALUE }) : null}
          // Where mail cannot be connected yet, say so once.
          mailComing={available === false}
        />
      ) : (
        <div className="wl-skeleton" role="status">
          <b className="sr-only">Getting things ready</b>
          <span className="is-title" />
          <span className="is-line" />
          <span className="is-card" />
        </div>
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
      <p className="sl-lede sl-rise" style={rise(2)}>One step with <WhiskWordmark />, our mail app, and I can start on your week right away.</p>
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
              {/* Held on the way out too: a same-tab connect leaves the page
                  once the server answers, and a press that seems to do nothing
                  for seconds reads as broken. */}
              {actions.busy || (opened && !error && !isDesktopShell()) ? CONNECT_WORDS.opening : <><span aria-hidden className="wl-whisk-glyph">{WHISK_GLYPH}</span>Connect with Whisk</>}
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
  // An errand the person picked on the marketing page leads, ahead of the
  // asks this step would offer.
  const [carried] = useState(takeCarriedAsk);
  const offered = firstAsks(can);
  const lead = carried ?? offered.lead;
  const more = carried ? [offered.lead, ...offered.more].filter((a): a is string => !!a && a !== carried).slice(0, offered.more.length) : offered.more;
  const [leaving, setLeaving] = useState<string | null>(null);
  // Asks show only once the deployment says it can think; a no, or no
  // answer in time, says so instead of offering asks that would only fail.
  const thinking = useThinkingAvailable();

  // The conversation's code loads while the person reads, so the landing is instant.
  useMountEffect(() => {
    void import("../conversation/[id]/page");
  });

  const begin = (text: string) => {
    if (leaving) return;
    forgetCarriedAsk();
    joinLane();
    const id = startHostedConversation(text);
    setLeaving(text);
    window.setTimeout(() => navigate(hostedConversationPath(id)), SEND_OFF_MS);
  };

  let i = 1;
  return (
    <section className="wl-screen" aria-labelledby="wl-start-title" data-leaving={leaving ? "" : undefined}>
      <h1 id="wl-start-title" className="sl-page-title sl-rise" style={rise(i++)}>
        {carried ? "Let's start with what you picked" : lead ? "Let's start with your week" : "What can I take off your plate?"}
      </h1>
      <p className="sl-lede sl-rise" style={rise(i++)}>
        {carried
          ? "Tap it and I'll get going, or say it in your own words."
          : lead
          ? "Here's a good first thing to ask. Tap it and I'll get going."
          : "Tap one to start, or say it in your own words."}
        {/* What is missing is said once, in the same line, and never ahead of
            an ask the person carried in. */}
        {mailComing && !carried ? ` ${MAIL_COMING}` : null}
      </p>
      {thinking === false ? <p className="sl-callout is-sun sl-rise" role="status" style={rise(i++)}>{THINKING_DOWN}</p> : null}
      {/* While no provider can think, the asks would only fail: the callout
          above says so and the way into the app stays. */}
      {thinking && lead ? (
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
      {thinking ? (
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
      ) : null}
      {thinking ? (
        <div className="wl-own sl-rise" style={rise(i++)}>
          <Composer placeholder="Or ask in your own words" onSend={begin} />
          {onConnect ? (
            <p className="wl-aside wl-mail-note">
              Want me to read your mail?{" "}
              <button type="button" className="wl-link wl-quiet" onClick={onConnect}>Connect it</button>
            </p>
          ) : null}
        </div>
      ) : null}
      <p className="wl-aside wl-foot sl-rise" style={rise(i++)}>
        <Link
          to={HOSTED_HOME}
          onClick={() => joinLane()}
          className="wl-go"
        >
          Go to my assistant <ArrowRight size={15} aria-hidden />
        </Link>
      </p>
    </section>
  );
}
