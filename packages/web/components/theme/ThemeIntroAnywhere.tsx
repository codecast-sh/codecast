"use client";
// The color themes introduction. Once per person, a corner card rises on the
// app's toast (RisingCard, the org introduction's card) with a swatch per
// theme: pressing one applies it on the spot, so the card is the picker in
// small. Done or All themes, or a swipe, answers it, and theme_intro_seen
// keeps it down on every device. It waits its turn: never over a call, a
// tour, a half-typed composer, a phone, hosted mode, or another rising card,
// and never before a machine has connected (a new account's first screen is
// about getting its sessions in, not the colors).

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Palette } from "lucide-react";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { useIsPhone } from "../../hooks/useIsPhone";
import { isHostedMode } from "../../lib/surfaces";
import { composerHasText, ORG_MEET_SETTLE_MS } from "../../lib/orgIntroCard";
import { settingsPathFor } from "../../lib/settingsSections";
import { RisingCard } from "../RisingCard";
import { useColorThemes } from "../../hooks/useColorThemes";
import { ThemeDot } from "./ThemePicker";
import { cliNeverConnected } from "../../lib/cliConnected";

const TOAST_ID = "theme-intro";
/** After the org card's settle, so the two never rise together. */
const SETTLE_MS = ORG_MEET_SETTLE_MS + 1200;

function markSeen() {
  const st = useInboxStore.getState();
  if (!st.clientState.ui?.theme_intro_seen) st.updateClientUI({ theme_intro_seen: true });
}

function ThemeIntroCard({ onDone, onAll }: { onDone: () => void; onAll: () => void }) {
  const { themes, current, choose } = useColorThemes();
  const title = themes.find((t) => t.key === current)?.theme.title;
  return (
    <RisingCard
      face={<span className="flex h-[46px] w-[46px] items-center justify-center rounded-full bg-sol-bg-alt text-sol-text"><Palette className="h-5 w-5" /></span>}
      title="Color themes"
      lines={[title ? `Now on ${title}. Try another:` : "Try one:"]}
      primaryLabel="Done"
      onPrimary={onDone}
      laterLabel="All themes"
      onLater={onAll}
      accent="var(--sol-link)"
      data-theme-intro
    >
      <div role="radiogroup" aria-label="Color theme" className="mt-2.5 flex flex-wrap gap-1">
        {themes.map((t) => <ThemeDot key={t.key} choice={t} checked={t.key === current} onChoose={() => choose(t.key)} />)}
      </div>
    </RisingCard>
  );
}

function showThemeIntro(onAll: () => void) {
  let answered = false;
  const answer = () => { if (!answered) { answered = true; markSeen(); } };
  toast.custom(
    (id) => (
      <ThemeIntroCard
        onDone={() => { answer(); toast.dismiss(id); }}
        onAll={() => { answer(); toast.dismiss(id); onAll(); }}
      />
    ),
    { id: TOAST_ID, duration: Infinity, onDismiss: answer },
  );
}

/** Mounted once in the dashboard layout. Renders nothing; raises the card once the page settles. */
export function ThemeIntroAnywhere() {
  const router = useRouter();
  const phone = useIsPhone();
  const s = useTrackedStore([
    (st) => st.clientStateInitialized,
    (st) => st.currentUser?._id,
    (st) => st.clientState.ui?.theme_intro_seen,
    (st) => isHostedMode(st),
    (st) => cliNeverConnected(st.currentUser),
  ]);
  const risen = useRef(false);
  const ready = s.clientStateInitialized && !!s.currentUser?._id && !phone && !isHostedMode(s) && !cliNeverConnected(s.currentUser);
  const seen = s.clientState.ui?.theme_intro_seen === true;

  // Answered on another device while the card is up: it goes.
  // eslint-disable-next-line no-restricted-syntax -- dismisses the toast when the intro is seen elsewhere
  useEffect(() => {
    if (risen.current && seen) toast.dismiss(TOAST_ID);
  }, [seen]);

  // eslint-disable-next-line no-restricted-syntax -- arms the rise timer when the facts that gate it change
  useEffect(() => {
    if (risen.current || !ready || seen) return;
    const t = window.setTimeout(() => {
      const st = useInboxStore.getState();
      const busy = (st.call?.phase ?? "idle") !== "idle" || !!st.tour || composerHasText() || toast.getToasts().length > 0;
      if (risen.current || busy || st.clientState.ui?.theme_intro_seen) return;
      risen.current = true;
      showThemeIntro(() => router.push(settingsPathFor("general")));
    }, SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [ready, seen, router]);

  return null;
}

// Dev console hook: __showThemeIntro() raises the card without the gate.
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined")
  (window as any).__showThemeIntro = () => showThemeIntro(() => window.location.assign("/settings/profile"));
