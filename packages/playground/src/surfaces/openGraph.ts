// The page's title and Open Graph tags follow the app in view, for the tab
// and for anything that renders the page. Unfurlers never run it; they get
// the app's preview from /og/<slug> (convex/lib/unfurl unfurlSlug).
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
