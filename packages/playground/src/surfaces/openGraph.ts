// The page's title and Open Graph tags follow the app in view. Static
// unfurlers read index.html's defaults; per-app unfurls need the server (see
// the shell's notes on /og).
import { useEffect } from "react";
import type { AppView } from "../../convex/apps";

function setMeta(property: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[property="${property}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("property", property);
    document.head.append(el);
  }
  el.content = content;
}

export function useOpenGraph(app: AppView | null): void {
  useEffect(() => {
    const title = app ? `${app.name} · Clayground` : "Clayground";
    const description = app?.live ? app.live.summary : "Make a thing. Pass it around. Anyone can change it by chatting.";
    document.title = title;
    setMeta("og:title", app?.name ?? "Clayground");
    setMeta("og:description", description);
    setMeta("og:url", location.href);
  }, [app?.name, app?.live?.summary]);
}
