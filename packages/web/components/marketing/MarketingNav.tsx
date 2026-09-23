"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AppleIcon } from "@/components/marketing/AppBadges";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { useLocalAuth } from "@/lib/localAuth";

/**
 * The one nav bar for every marketing page (landing, pricing, docs, blog...).
 *
 * The link set lives here and nowhere else, so a page cannot drift into its
 * own subset. The right side knows whether the visitor is signed in: a
 * signed-in visitor gets "Open app" instead of sign-in/sign-up, which is what
 * lets the marketing site stay reachable from inside the app (the root URL no
 * longer bounces signed-in browsers to the inbox). The auth read is the
 * local-first one — a stored token is enough — so the bar never flashes the
 * signed-out state while the server confirms.
 */
const MARKETING_NAV_LINKS = [
  { href: "/documentation", label: "Docs" },
  { href: "/features", label: "CLI" },
  { href: "/pricing", label: "Pricing" },
  { href: "/changelog", label: "Changelog" },
  { href: "/blog", label: "Blog" },
  { href: "/security", label: "Security" },
  { href: "/support", label: "Support" },
] as const;

const INK = "#002b36";
const MUTED = "#657b83";

function GitHubIcon() {
  return (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function MarketingNav({
  active,
  crumb,
  containerClassName = "max-w-6xl",
}: {
  /** Path of the page rendering the bar; that link paints in ink instead of muted. */
  active?: string;
  /** A "/ docs" style breadcrumb beside the logo (the reference pages use it). */
  crumb?: string;
  /** Width class of the inner container, so the bar lines up with the page below it. */
  containerClassName?: string;
}) {
  const signedIn = useLocalAuth();
  return (
    <nav
      className="backdrop-blur-sm sticky top-0 z-50"
      style={{ borderBottom: "1px solid #eee8d5", backgroundColor: "rgba(253,246,227,0.8)" }}
    >
      <div className={`${containerClassName} mx-auto px-6 ${crumb ? "py-3" : "py-4"} flex items-center justify-between`}>
        <div className="flex items-center gap-6">
          <Link href="/" aria-label="Codecast home">
            <Logo size="md" className="[--logo-c:#444444] text-[#002b36]" />
          </Link>
          {crumb && (
            <div className="hidden md:flex items-center gap-1">
              <span style={{ color: "#586e75" }}>/</span>
              <span className="font-mono text-sm font-medium" style={{ color: INK }}>{crumb}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          {MARKETING_NAV_LINKS.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className="hidden md:block font-medium text-sm px-3 py-1.5 transition-colors hover:text-[#002b36]"
              style={{ color: href === active ? INK : MUTED }}
            >
              {label}
            </Link>
          ))}
          {/* The apps page is the one link that stays visible at every width:
              a visitor on a phone or a Mac should always see there is an app. */}
          <Link
            href="/download"
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-[#eee8d5]"
            style={{ borderColor: active === "/download" ? INK : "#93a1a1", color: INK }}
          >
            <AppleIcon className="w-4 h-4" />
            <span className="hidden sm:inline">Download</span>
            <span className="sm:hidden">Apps</span>
          </Link>
          <a
            href="https://github.com/codecast-sh/codecast"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:flex items-center px-2 py-1.5 transition-colors hover:text-[#002b36]"
            style={{ color: MUTED }}
            aria-label="GitHub"
          >
            <GitHubIcon />
          </a>
          {signedIn ? (
            <Link href="/inbox">
              <Button className="font-medium text-[#fdf6e3] gap-1.5 hover:bg-[#073642]" style={{ backgroundColor: INK }}>
                Open app
                <ArrowRight className="w-4 h-4" />
              </Button>
            </Link>
          ) : (
            <>
              <Link href="/login">
                <Button variant="ghost" className="font-medium text-[#657b83] hover:text-[#002b36] hover:bg-[#eee8d5]">
                  Sign in
                </Button>
              </Link>
              <Link href="/signup">
                <Button className="font-medium text-[#fdf6e3] hover:bg-[#073642]" style={{ backgroundColor: INK }}>
                  Get started
                </Button>
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
