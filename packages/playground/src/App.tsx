// The shell: who you are, where you are, and the few things every page shares
// (toasts, the character picker, the reconnecting pill).
import { useEffect, useState } from "react";
import { characterTitle } from "./lib/avatars";
import { convex } from "./lib/convex";
import { IdentityProvider, useIdentity } from "./lib/identity";
import { parseRoute, useLocation } from "./lib/router";
import { Blob } from "./ui/Blob";
import { Dots } from "./ui/Dots";
import { ToastProvider, useToast } from "./ui/Toast";
import { AppPage } from "./surfaces/AppPage";
import { CharacterPickerHost, useCharacterPicker } from "./surfaces/CharacterPicker";
import { Home } from "./surfaces/Home";
import { NotFound } from "./surfaces/NotFound";
import s from "./App.module.css";

export function App() {
  return (
    <ToastProvider>
      <IdentityProvider fallback={<Booting />}>
        <CharacterPickerHost>
          <Hello />
          <Routes />
        </CharacterPickerHost>
      </IdentityProvider>
      <Reconnecting />
    </ToastProvider>
  );
}

function Routes() {
  const href = useLocation();
  const url = new URL(href, location.origin);
  const route = parseRoute(url.pathname, url.search);
  useEffect(() => window.scrollTo(0, 0), [route.kind === "app" ? route.slug : route.kind]);
  if (route.kind === "home") return <Home />;
  if (route.kind === "missing") return <NotFound />;
  return <AppPage slug={route.slug} version={route.version} room={route.room} />;
}

/** First arrival: no picker, just who you are now, and a way to change it. */
function Hello() {
  const { me, fresh } = useIdentity();
  const toast = useToast();
  const openPicker = useCharacterPicker();
  useEffect(() => {
    if (!fresh) return;
    toast({ face: me, text: `You're ${characterTitle(me)}.`, action: { label: "Change", onClick: () => openPicker() } });
  }, [fresh]);
  return null;
}

function Booting() {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setLate(true), 400);
    return () => clearTimeout(t);
  }, []);
  return <div className={s.boot}>{late && <Blob size={72} squash />}</div>;
}

/** Shown when the connection drops after it was up; gone without fanfare. */
function Reconnecting() {
  const [down, setDown] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const st = convex.connectionState();
      const lost = st.hasEverConnected && !st.isWebSocketConnected;
      clearTimeout(timer);
      if (!lost) setDown(false);
      else timer = setTimeout(() => setDown(true), 1000);
    };
    const unsub = convex.subscribeToConnectionState(check);
    return () => {
      unsub();
      clearTimeout(timer);
    };
  }, []);
  if (!down) return null;
  return (
    <div className={s.reconnecting} role="status">
      Reconnecting <Dots size={5} light />
    </div>
  );
}
