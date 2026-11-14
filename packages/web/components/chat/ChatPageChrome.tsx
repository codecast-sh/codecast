import Link from "next/link";
import { Search } from "lucide-react";
import { MenuKeyCaps } from "../KeyboardShortcutsHelp";
import { Logo } from "../Logo";

/** The header's search affordance — a quiet pill wearing its shortcut. */
export function SearchPill({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="ch-search-open" title="Search messages" onClick={onOpen}>
      <Search className="w-3 h-3" />
      Search
      <span className="ch-search-keys">
        <MenuKeyCaps action="chat.search" />
      </span>
    </button>
  );
}

/** Where the composer would be, for a visitor: reading is open, posting needs
 *  an account. The link comes back to this exact room. */
export function SignInToPost({ compact }: { compact?: boolean }) {
  const here = typeof window === "undefined" ? "/community" : window.location.pathname + window.location.search;
  const back = encodeURIComponent(here);
  return (
    <div className={`ch-guest-post${compact ? " ch-guest-post-compact" : ""}`}>
      <span className="ch-guest-post-text">Anyone can read. Sign in to post.</span>
      <Link href={`/login?return_to=${back}`} className="ch-empty-action">Sign in</Link>
      <Link href={`/signup?return_to=${back}`} className="ch-guest-post-alt">Create an account</Link>
    </div>
  );
}

/** The community page's own chrome when it stands alone in a browser: who we
 *  are, where this is, the way back to the site, and the door into the app. */
export function CommunityBar({ isGuest }: { isGuest: boolean }) {
  const here = typeof window === "undefined" ? "/community" : window.location.pathname + window.location.search;
  return (
    <header className="ch-community-bar">
      <a href="/" className="ch-community-brand" aria-label="Codecast home">
        <Logo size="sm" className="[--logo-c:currentColor]" />
      </a>
      <span className="ch-community-where">
        <span className="ch-community-slash" aria-hidden="true">/</span>
        community
      </span>
      <nav className="ch-community-links" aria-label="Site">
        <a href="/documentation">Docs</a>
        <a href="/changelog">Changelog</a>
        <a href="/support">Support</a>
      </nav>
      <span className="ch-community-spacer" />
      {isGuest ? (
        <Link href={`/login?return_to=${encodeURIComponent(here)}`} className="ch-community-cta">Sign in</Link>
      ) : (
        <Link href="/inbox" className="ch-community-cta">Open the app</Link>
      )}
    </header>
  );
}
