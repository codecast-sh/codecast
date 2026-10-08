// The shell: who you are, where you are, and the few things every page shares
// (toasts, the character picker). Every page draws at once; only what needs
// a visitor waits for this browser to become one.
import { useEffect } from "react";
import { characterTitle } from "./lib/avatars";
import { IdentityProvider, useMaybeIdentity } from "./lib/identity";
import { parseRoute, useLocation } from "./lib/router";
import { ToastProvider, useToast } from "./ui/Toast";
import { AppPage } from "./surfaces/AppPage";
import { CharacterPickerHost, useCharacterPicker } from "./surfaces/CharacterPicker";
import { Home, NotFound } from "./surfaces/pages";


export function App() {
  return (
    <ToastProvider>
      <IdentityProvider>
        <CharacterPickerHost>
          <Hello />
          <Routes />
        </CharacterPickerHost>
      </IdentityProvider>
    </ToastProvider>
  );
}

function Routes() {
  const href = useLocation();
  const url = new URL(href, location.origin);
  const route = parseRoute(url.pathname, url.search);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.kind === "app" ? route.slug : route.kind]);
  if (route.kind === "app") return <AppPage slug={route.slug} version={route.version} room={route.room} />;
  return route.kind === "home" ? <Home /> : <NotFound />;
}

/** First arrival: no picker, just who you are now, and a way to change it. */
function Hello() {
  const identity = useMaybeIdentity();
  const toast = useToast();
  const openPicker = useCharacterPicker();
  const fresh = identity?.fresh ?? false;
  useEffect(() => {
    if (!fresh || !identity) return;
    toast({ face: identity.me, text: `You're ${characterTitle(identity.me)}.`, action: { label: "Pick another", onClick: () => openPicker() } });
  }, [fresh]);
  return null;
}
