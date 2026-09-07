// The one control that moves a repository page between its two forms.
//
// In the app it opens the page in the person's browser, as the standalone
// form of the same URL: a plain page that can be bookmarked or handed to
// someone. In that form it offers the way back in.
import Link from "next/link";
import { ExternalLink, PanelsTopLeft } from "lucide-react";
import { toast } from "sonner";
import { useLocalAuth } from "../../lib/localAuth";
import { openInBrowser } from "../../lib/popOut";
import { toAppHref, toStandaloneHref } from "../../lib/repoView";
import { useRepoLocation } from "./useRepoFamily";

const CONTROL =
  "flex items-center gap-1.5 h-7 rounded-md border border-sol-border/60 px-2 text-[12px] text-sol-text-muted hover:text-sol-text hover:border-sol-border transition-colors";

function openAsPage(here: string): void {
  const url = new URL(toStandaloneHref(here), window.location.origin).toString();
  if (openInBrowser(url) === "needs-update") {
    toast.error("The desktop app needs an update for this", {
      description: "This build cannot hand a page to your browser. Update Codecast and it opens on its own.",
    });
  }
}

export function RepoWindowControl() {
  const { pathname, search, hash, family } = useRepoLocation();
  const signedIn = useLocalAuth();
  const here = pathname + search + hash;

  if (family === "standalone") {
    // Only for somebody who HAS an app to open. The app form is behind the
    // sign in gate, so offering it to a public reader would bounce them to the
    // marketing home with no explanation of why.
    if (!signedIn) return null;
    return (
      <Link href={toAppHref(here)} className={CONTROL} title="Open this page in the app">
        <PanelsTopLeft className="w-3 h-3" />
        Open in app
      </Link>
    );
  }

  return (
    <button type="button" onClick={() => openAsPage(here)} className={CONTROL} title="Open as a page in your browser">
      <ExternalLink className="w-3 h-3" />
    </button>
  );
}
