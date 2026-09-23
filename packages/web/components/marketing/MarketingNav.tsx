"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AppleIcon } from "@/components/marketing/AppBadges";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { useLocalAuth } from "@/lib/localAuth";
import { RepoPulseChip } from "@/components/marketing/RepoPulseChip";

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
          <RepoPulseChip className="hidden sm:flex" />
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
