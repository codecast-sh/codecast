"use client";
// The one time the app brings up a feature a team never decided on (Org,
// then Flows): a card rises in the corner, once per person per feature, with
// the guide one press away. It rides the same rising card and the same "may it
// rise now" rule as the org introduction (lib/orgIntroCard): the page has
// settled, no call, no composer holding text, not on a phone, not on the
// feature's own page. Answering either way writes `offer:<feature>` into the
// tips bag, the record every tour and tip already shares, so it never rises
// again on any device; watching the guide by any route also counts.
//
// An admin whose team left two or more of the setup features undecided (a
// team made before new teams started with them on) is offered the team setup
// page instead, the setup flow's Features and Agents steps; finishing it
// decides every one, so the single-feature cards never follow.
//
// Nothing rises for a feature that is on (the org introduction speaks then),
// for one an admin turned off, or while tips are off.
import { useLocation, useNavigate } from "react-router";
import { isSetupFlowPath } from "../../lib/setupFlow";
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { undecidedSetupFeatures, workspaceFeatureState, type TeamFeatureKey } from "@codecast/shared/contracts";
import { TeamCrest } from "../../components/team/TeamCrest";
import { activeTeamIdOf } from "../../lib/activeTeam";
import { RisingCard } from "../../components/RisingCard";
import { RoleAvatar } from "../../components/org/avatars";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { useIsPhone } from "../../hooks/useIsPhone";
import { ORG_MEET_SETTLE_MS, composerHasText, orgIntroCardMayRise } from "../../lib/orgIntroCard";
import { startTour } from "../engine";
import { isTourSeen } from "../seen";
import { tourById, watchGuideLabel } from "../registry";

type Offer = { feature: TeamFeatureKey; guide: string; home: string; face: string; accent: string; title: string; lines: [string, string] };

const OFFERS: Offer[] = [
  {
    feature: "org", guide: "org-guide", home: "/org", face: "owl", accent: "var(--sol-violet)",
    title: "New: Org",
    lines: ["Roles that each own an area of work, so most questions never reach you.", "The guide shows it on an example team."],
  },
  {
    feature: "line", guide: "flows-guide", home: "/flows", face: "hedgehog", accent: "var(--sol-cyan)",
    title: "New: Flows",
    lines: ["Every change through steps your team can see, and one card for you to decide.", "The guide shows it on an example change."],
  },
];

export const offerSeenId = (feature: TeamFeatureKey | "setup") => `offer:${feature}`;
const SETUP_HOME = "/settings/team/features";

function markOffered(feature: TeamFeatureKey | "setup") {
  const st = useInboxStore.getState();
  const dismissed = st.clientState.tips?.dismissed ?? [];
  if (!dismissed.includes(offerSeenId(feature))) st.updateClientTips({ dismissed: [...dismissed, offerSeenId(feature)] });
}

type Store = ReturnType<typeof useInboxStore.getState>;
type SetupOffer = { team: { name: string; icon?: string; icon_color?: string }; names: string[] };

/** The team setup offer: the active team is the viewer's to run and has two or more setup features undecided. */
function pendingSetup(st: Store): SetupOffer | null {
  if (st.clientState.tips?.level === "none") return null;
  if ((st.clientState.tips?.dismissed ?? []).includes(offerSeenId("setup"))) return null;
  const id = activeTeamIdOf(st);
  const team: any = id ? (st.teams || []).find((t: any) => t && String(t._id) === id) : null;
  if (!team || (team.role !== "admin" && team.role !== "owner")) return null;
  const undecided = undecidedSetupFeatures(team);
  return undecided.length >= 2 ? { team, names: undecided.map((f) => f.name) } : null;
}

/** The offer that may rise now, if any: undecided, not answered, its guide not seen. */
function pendingOffer(st: Store): Offer | null {
  if (st.clientState.tips?.level === "none") return null;
  if (pendingSetup(st)) return null;
  const dismissed = st.clientState.tips?.dismissed ?? [];
  for (const o of OFFERS) {
    if (workspaceFeatureState(st.teams || [], st.clientState.ui?.active_team_id, o.feature) !== "offer") continue;
    if (dismissed.includes(offerSeenId(o.feature))) continue;
    const def = tourById(o.guide);
    if (def && isTourSeen(def, st.clientState)) continue;
    return o;
  }
  return null;
}

/** Mounted once in the dashboard layout. Renders nothing; raises at most one card a page load. */
export function FeatureOfferAnywhere() {
  const pathname = usePathname();
  const phone = useIsPhone();
  const navigate = useNavigate();
  const s = useTrackedStore([
    (st) => st.clientStateInitialized,
    (st) => st.currentUser?._id,
    (st) => st.call?.phase,
    (st) => (pendingSetup(st) ? "setup" : pendingOffer(st)?.feature ?? null),
  ]);
  const risen = useRef(false);
  const setup = pendingSetup(s);
  const offer = pendingOffer(s);
  const offerKey = setup ? "setup" : offer?.feature ?? null;
  const home = setup ? SETUP_HOME : offer?.home ?? "";
  // The setup flow on screen keeps the corner quiet (lib/setupFlow).
  const blocked = isSetupFlowPath(useLocation().pathname);

  // eslint-disable-next-line no-restricted-syntax -- arms the rise timer when the facts that gate it change
  useEffect(() => {
    if (risen.current || !offerKey || blocked) return;
    const facts = () => ({
      initialized: s.clientStateInitialized,
      signedIn: !!s.currentUser?._id,
      onOrgPage: !!pathname && (pathname === home || pathname.startsWith(`${home}/`)),
      phone,
      callPhase: useInboxStore.getState().call?.phase ?? "idle",
      composerHasText: composerHasText(),
      introSeen: false,
      upsellSeen: false,
    });
    if (!orgIntroCardMayRise({ ...facts(), composerHasText: false })) return;
    let t = 0;
    const tryRise = () => {
      const st = useInboxStore.getState();
      const nowSetup = pendingSetup(st);
      const now = nowSetup ? "setup" : pendingOffer(st)?.feature ?? null;
      // A tour or guide on screen keeps the corner quiet.
      if (risen.current || st.tour || now !== offerKey || !orgIntroCardMayRise(facts())) return;
      // Another card in the corner (a theme intro, a toast) goes first; this one waits its turn.
      if (toast.getToasts().length > 0) { t = window.setTimeout(tryRise, 4000); return; }
      risen.current = true;
      if (nowSetup) showSetupOffer(nowSetup, () => navigate(SETUP_HOME));
      else { const o = pendingOffer(st); if (o) showOffer(o); }
    };
    t = window.setTimeout(tryRise, ORG_MEET_SETTLE_MS + 1200);
    return () => window.clearTimeout(t);
  }, [offerKey, blocked, s.clientStateInitialized, s.currentUser?._id, s.call?.phase, pathname, phone]);

  return null;
}

function showOffer(o: Offer, record = true) {
  const id = `feature-offer-${o.feature}`;
  let answered = false;
  const answer = () => { if (!answered) { answered = true; if (record) markOffered(o.feature); } };
  toast.custom(
    (tid) => (
      <RisingCard
        face={<RoleAvatar avatar={o.face} size={46} />}
        title={o.title}
        lines={o.lines}
        accent={o.accent}
        primaryLabel={watchGuideLabel(o.guide)}
        onPrimary={() => { answer(); toast.dismiss(tid); startTour(o.guide, { replay: true }); }}
        laterLabel="Not now"
        onLater={() => { answer(); toast.dismiss(tid); }}
        data-feature-offer={o.feature}
      />
    ),
    { id, duration: Infinity, onDismiss: answer },
  );
}

/** "Chat, Calls and Flows". */
function listNames(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function showSetupOffer(o: SetupOffer, open: () => void, record = true) {
  let answered = false;
  const answer = () => { if (!answered) { answered = true; if (record) markOffered("setup"); } };
  toast.custom(
    (tid) => (
      <RisingCard
        face={<TeamCrest icon={o.team.icon} color={o.team.icon_color} size="lg" tone="strong" />}
        title="Turn on all of Codecast"
        lines={[`${o.team.name} has ${listNames(o.names)} off.`, "One step turns them on for the whole team."]}
        accent="var(--sol-blue)"
        primaryLabel="Turn them on"
        onPrimary={() => { answer(); toast.dismiss(tid); open(); }}
        laterLabel="Not now"
        onLater={() => { answer(); toast.dismiss(tid); }}
        data-feature-offer="setup"
      />
    ),
    { id: "feature-offer-setup", duration: Infinity, onDismiss: answer },
  );
}

// Dev console hook, the org introduction's convention: raise a card in any state to check its look.
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined")
  (window as any).__showFeatureOffer = (feature: TeamFeatureKey | "setup" = "org") => {
    if (feature === "setup") return showSetupOffer({ team: { name: "Acme" }, names: ["Chat", "Calls", "Flows"] }, () => {}, false);
    const o = OFFERS.find((x) => x.feature === feature); if (o) showOffer(o, false);
  };
