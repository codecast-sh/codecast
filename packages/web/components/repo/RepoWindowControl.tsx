// The one control that moves a repository page between its two forms.
//
// In the app it pops the page out into a window of its own, which is the
// standalone form of the same URL. In that window it offers the way back in.
import Link from "next/link";
import { PictureInPicture2, PanelsTopLeft } from "lucide-react";
import { toast } from "sonner";
import { useLocalAuth } from "../../lib/localAuth";
import { popOutWindow } from "../../lib/popOut";
import { toAppHref, toStandaloneHref } from "../../lib/repoView";
import { useRepoLocation } from "./useRepoFamily";

const CONTROL =
  "flex items-center gap-1.5 h-7 rounded-md border border-sol-border/60 px-2 text-[12px] text-sol-text-muted hover:text-sol-text hover:border-sol-border transition-colors";

async function popOutRepo(here: string): Promise<void> {
  const outcome = await popOutWindow(toStandaloneHref(here), undefined, {
    name: "codecast-repo",
    width: 1240,
    height: 860,
  });
  if (outcome === "needs-update") {
    toast.error("The desktop app needs an update for this", {
      description: "This build cannot break a page out into a window. Update Codecast and it opens on its own.",
    });
    return;
  }
  if (outcome === "blocked") {
    toast.error("Your browser blocked the window", {
      description: "Allow popups for this site, or open it as a tab instead.",
      action: {
        label: "Open as a tab",
        onClick: () => window.open(toStandaloneHref(here), "codecast-repo"),
      },
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
    <button type="button" onClick={() => void popOutRepo(here)} className={CONTROL} title="Open in its own window">
      <PictureInPicture2 className="w-3 h-3" />
    </button>
  );
}
