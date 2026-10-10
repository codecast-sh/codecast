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
import { HostedWordmark } from "../../components/HostedWordmark";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
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
import { UseWhiskNow } from "../../components/simple/UseWhiskNow";
import { ASSISTANT_HEADLINE, MAIL_COMING, THINKING_DOWN, assistantPromise, useConnectAvailable, useThinkingAvailable } from "../../components/simple/assistantPromise";
import { AssistantPrivacyNote } from "../../components/simple/AssistantPrivacyNote";
import { Composer } from "../../components/simple/Composer";
import { ConnectNotice } from "../../components/simple/ConnectNotice";
import { calendarAbility, disconnectNote, emailAbility } from "../../components/simple/connectionWords";
import { LaneSync } from "../../components/simple/LaneSync";
import { ASK_FIRST, LANE_COPY, LANE_PATHS, firstAsks, plainConnectError, type MailAbilities } from "../../components/simple/lane";
import { LANE_SWITCH } from "../../components/simple/lanePref";
import { HOSTED_HOME, WELCOME_ASK_PARAM, hostedConversationPath } from "../../components/simple/lanePaths";
import { isHostedUi, writeLane } from "../../components/simple/lanePref";
import { simpleModeAllowed } from "../../components/simple/lanePaths";
import { carriedAsk, forgetCarriedAsk, keepCarriedAsk, takeCarriedAsk } from "../../components/simple/carriedAsk";
import { takeAuthReturn } from "../../lib/authReturn";
import { isHostedAgentType } from "@codecast/shared/contracts";
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

// Names read as progress, never as actions: the first step is not called
// "Sign in", because the top corner is where a sign-in link usually sits.
const STEP_NAMES: Record<WelcomeStep, string> = { signin: "Your account", connect: "Connect", start: "Start" };
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
  // Hosted mode is staff-only for now (simpleModeAllowed): anyone else
  // signed in goes to the app.
  const closed = useInboxStore((s) => !!s.currentUser && !simpleModeAllowed(s.currentUser));
  if (signedIn && closed) return <Navigate to="/inbox" replace />;
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
        <HostedWordmark size={20} className="wl-brand" />
        <div className="wl-progress">
          <ol className="wl-rail" aria-label={at >= 0 ? `Step ${at + 1} of ${trail.length}: ${STEP_NAMES[trail[at]]}` : `${trail.length} steps`}>
            {trail.map((s, i) => (
              <li key={s} className={at < 0 ? undefined : i < at ? "is-done" : i === at ? "is-here" : undefined}>
                <span className="wl-rail-name">{STEP_NAMES[s]}</span>
              </li>
            ))}
          </ol>
          {at >= 0 && <span className="wl-rail-count" aria-hidden>Step {at + 1} of {trail.length}</span>}
        </div>
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
      <AssistantPrivacyNote mail={mail} className="wl-aside sl-rise" style={rise(2)} />
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

/** Whether this person already has conversations with the assistant: they
 *  belong in their inbox, not on the first-run starters. */
function hasHostedConversations(sessions: Record<string, { agent_type?: string | null; message_count?: number }>): boolean {
  for (const id in sessions) if (isHostedAgentType(sessions[id]?.agent_type) && (sessions[id]?.message_count ?? 0) > 0) return true;
  return false;
}

function SignedIn() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  // Signed in again after a moment that only looked signed out: back to the
  // page AuthGuard left (lib/authReturn). Someone who already talks to the
  // assistant and came here with no step and nothing to ask goes to their
  // inbox rather than the starters. A conversation this page just started is
  // not a return: its first ask is on its way to the conversation itself.
  const returning = useInboxStore((s) => hasHostedConversations(s.sessions));
  const asked = useRef(false);
  useWatchEffect(() => {
    const back = takeAuthReturn();
    if (back) { navigate(back, { replace: true }); return; }
    if (returning && !asked.current && params.toString() === "" && !carriedAsk()) navigate(HOSTED_HOME, { replace: true });
  }, [returning]);
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
          // Where mail cannot be connected yet, say so once. A person already
          // connected (a tester ahead of the opening) is not told it's coming.
          // Only once the connection has answered: a read still in flight
          // is not "not connected".
          mailComing={mail.known && available === false && !mail.connected}
          onAsk={() => { asked.current = true; }}
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

function Start({ can, onConnect, mailComing, onAsk }: { can: MailAbilities | null; onConnect: (() => void) | null; mailComing: boolean; onAsk: () => void }) {
  const navigate = useNavigate();
  // An errand the person picked on the marketing page leads, ahead of the
  // asks this step would offer.
  const [carried] = useState(takeCarriedAsk);
  const offered = firstAsks(can);
  const lead = carried ?? offered.lead;
  const more = carried ? [offered.lead, ...offered.more].filter((a): a is string => !!a && a !== carried).slice(0, offered.more.length) : offered.more;
  const [leaving, setLeaving] = useState<string | null>(null);
  // Asks show unless the deployment has said it cannot think: a slow answer
  // is not an outage, and a real one turns a send into its own notice. On a
  // no, a carried errand stays on screen, held, and stays saved for later.
  const thinking = useThinkingAvailable();
  const down = thinking === false;

  // The conversation's code loads while the person reads, so the landing is instant.
  useMountEffect(() => {
    void import("../conversation/[id]/page");
  });

  const begin = (text: string) => {
    if (leaving) return;
    onAsk();
    forgetCarriedAsk();
    joinLane();
    const id = startHostedConversation(text);
    setLeaving(text);
    window.setTimeout(() => navigate(hostedConversationPath(id)), SEND_OFF_MS);
  };

  // The errand picked on the marketing page was the person's click: it is
  // asked as soon as the assistant can think, with no second "Ask this".
  // An outage holds it on screen (below) and keeps it saved.
  // An account already working in developer mode chooses the switch itself:
  // it is told what asking here does, and nothing is asked on arrival.
  const developer = useInboxStore((s) => {
    const lane = s.clientState?.ui?.lane;
    return lane !== undefined && !isHostedUi(s.clientState?.ui);
  });
  useWatchEffect(() => {
    if (carried && thinking === true && !developer && !leaving) begin(carried);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carried, thinking, developer]);

  let i = 1;
  return (
    <section className="wl-screen" aria-labelledby="wl-start-title" data-leaving={leaving ? "" : undefined}>
      <h1 id="wl-start-title" className="sl-page-title sl-rise" style={rise(i++)}>
        {carried && leaving === carried ? "Starting on it" : carried ? "Let's start with what you picked" : lead ? "Let's start with your week" : "What can I take off your plate?"}
      </h1>
      <p className="sl-lede sl-rise" style={rise(i++)}>
        {carried && down
          ? "I've kept it for you. It will be waiting in your inbox, ready to ask."
          : carried
          ? "Tap it and I'll get going, or say it in your own words."
          : lead
          ? "Here's a good first thing to ask. Tap it and I'll get going."
          : "Tap one to start, or say it in your own words."}
        {/* What is missing is said once, in the same line, and never ahead of
            an ask the person carried in. */}
        {mailComing && !carried ? <> {MAIL_COMING} <UseWhiskNow inline className="wl-link" />.</> : null}
      </p>
      {developer ? <p className="wl-aside sl-rise" style={rise(i++)}>{LANE_SWITCH.welcomeSwitches}</p> : null}
      {down ? <p className="sl-callout is-sun sl-rise" role="status" style={rise(i++)}>{THINKING_DOWN}</p> : null}
      {/* While no provider can think, asks would only fail: a carried errand
          stays, held, and the rest wait with the composer. */}
      {lead && down && carried ? (
        <div className="wl-lead is-held sl-rise" style={rise(i++)} aria-disabled="true">
          <span className="wl-lead-text">{lead}</span>
          <span className="wl-lead-go">Saved for later</span>
        </div>
      ) : null}
      {lead && !down ? (
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
      {!down ? (
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
      {!down ? (
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
          Go to your inbox <ArrowRight size={15} aria-hidden />
        </Link>
      </p>
    </section>
  );
}
