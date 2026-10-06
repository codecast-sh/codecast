"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Download } from "lucide-react";
import { AppleIcon } from "@/components/marketing/AppBadges";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { useLocalAuth } from "@/lib/localAuth";
import { RepoPulseChip } from "@/components/marketing/RepoPulseChip";
import { useMountEffect } from "@/hooks/useMountEffect";
import { visitorPlatform } from "@/lib/visitorPlatform";

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
  // The path for someone who does not write code: the hosted assistant's
  // own door (/welcome), first so it is not lost among the developer pages.
  { href: "/welcome", label: "For everyone" },
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
  // The Apple mark promises an app this visitor can run; elsewhere the apps
  // page leads with the CLI and the browser, so a plain download mark fits.
  // Decided after mount so the prerendered bar and the first client paint agree.
  const [apple, setApple] = useState(true);
  useMountEffect(() => {
    const p = visitorPlatform();
    setApple(p === "mac" || p === "ios");
  });
  return (
    <nav
      className="backdrop-blur-sm sticky top-0 z-50"
      style={{ borderBottom: "1px solid #eee8d5", backgroundColor: "rgba(253,246,227,0.8)" }}
    >
      <div className={`${containerClassName} mx-auto px-4 sm:px-6 ${crumb ? "py-3" : "py-4"} flex items-center justify-between gap-2`}>
        <div className="flex items-center gap-6 shrink-0">
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
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
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
            aria-label="Download the apps"
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 sm:px-3 py-1.5 text-sm font-medium transition-colors hover:bg-[#eee8d5]"
            style={{ borderColor: active === "/download" ? INK : "#93a1a1", color: INK }}
          >
            {apple ? <AppleIcon className="w-4 h-4" /> : <Download className="w-4 h-4" />}
            <span className="hidden sm:inline">Download</span>
            <span className="sm:hidden max-[379px]:hidden">Apps</span>
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
              {/* Phones have room for one auth button; signup links to sign in. */}
              <Link href="/login" className="hidden sm:block">
                <Button variant="ghost" className="font-medium text-[#657b83] hover:text-[#002b36] hover:bg-[#eee8d5]">
                  Sign in
                </Button>
              </Link>
              <Link href="/signup">
                <Button className="max-[379px]:px-3 font-medium text-[#fdf6e3] hover:bg-[#073642]" style={{ backgroundColor: INK }}>
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
