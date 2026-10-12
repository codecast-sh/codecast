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
import { HostedWordmark } from "@/components/HostedWordmark";
import { LANE_PATHS } from "@/components/simple/lanePaths";

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
  { href: "/features", label: "Features" },
  { href: "/pricing", label: "Pricing" },
  { href: "/changelog", label: "Changelog" },
  { href: "/blog", label: "Blog" },
  // Security and Support live in the footer (MarketingFooter), which leaves
  // the bar room for "Open app" at a laptop's width.
] as const;

/** The assistant's own page: the campaign door (/everyone redirects here),
 *  set in the family's interface face. The developer bar does not link it. */
const EVERYONE_HREF = "/?for=assistant";
const WAY_FONT = { fontFamily: "var(--pd-font-ui, ui-sans-serif, system-ui, sans-serif)" } as const;

const INK = "#002b36";
const MUTED = "#657b83";

/** The bar a visitor sees after coming through the assistant's door: only
 *  what someone who does not write code needs (the assistant's section, its
 *  pricing, signing in), in the family's paper and faces, with the hosted
 *  wordmark. The developer links (Docs, Features, Changelog, stars, Download)
 *  stay on the developer bar. */
const DOOR_LINKS = [
  // The door's landing is the For everyone page itself, so the link reads as
  // where the visitor already is.
  { href: EVERYONE_HREF, label: "For everyone", active: "/" },
  { href: "/pricing?for=assistant", label: "Pricing", active: "/pricing" },
] as const;
const DOOR = {
  ink: "var(--pd-ink, #201c17)",
  muted: "var(--pd-ink-muted, #6b6355)",
  rule: "var(--pd-rule, #e4ddce)",
  accent: "var(--pd-accent, #c93a0e)",
  accentInk: "var(--pd-accent-ink, #fdfbf6)",
} as const;

export function MarketingNav({
  active,
  crumb,
  containerClassName = "max-w-6xl",
  door,
}: {
  /** "assistant": the visitor came through the assistant's door (pricing's
   *  ?for=assistant), so the bar is the assistant's (DOOR_LINKS). */
  door?: "assistant";
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
  // The auth buttons wait for the client: the prerendered bar cannot know who
  // is visiting, and drawing "Sign in" first flips to "Open app" a moment
  // later for everyone signed in. A fixed-width slot holds the place.
  const [mounted, setMounted] = useState(false);
  useMountEffect(() => {
    const p = visitorPlatform();
    setApple(p === "mac" || p === "ios");
    setMounted(true);
  });
  if (door === "assistant") {
    return (
      <nav
        className="backdrop-blur-sm sticky top-0 z-50"
        style={{ borderBottom: `1px solid ${DOOR.rule}`, backgroundColor: "color-mix(in srgb, var(--pd-bg, #f6f3ec) 85%, transparent)", ...WAY_FONT }}
      >
        <div className={`${containerClassName} mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-2`}>
          <Link href={EVERYONE_HREF} aria-label="Codecast for everyone">
            <HostedWordmark size={20} className="text-[19px]" />
          </Link>
          <div className="flex items-center gap-2 sm:gap-2.5 shrink-0">
            {DOOR_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={link.active === active ? "page" : undefined}
                className="hidden sm:flex items-center px-2.5 py-1.5 text-[14px] font-medium transition-colors"
                style={{ color: link.active === active ? DOOR.ink : DOOR.muted }}
              >
                {link.label}
              </Link>
            ))}
            {!mounted ? (
              <span aria-hidden className="block h-9 w-[7.5rem] shrink-0" />
            ) : signedIn ? (
              // A quiet link: the page's own Get started is the one filled
              // button on this door.
              <Link href="/inbox" className="inline-flex h-9 items-center gap-1.5 px-2.5 text-[14px] font-medium underline-offset-4 hover:underline" style={{ color: DOOR.ink }}>
                Open app <ArrowRight className="w-4 h-4" />
              </Link>
            ) : (
              <>
                <Link href="/login" className="hidden sm:flex items-center px-2.5 py-1.5 text-[14px] font-medium" style={{ color: DOOR.muted }}>
                  Sign in
                </Link>
                <Link href={LANE_PATHS.welcome} className="inline-flex h-9 items-center rounded-[10px] px-4 text-[14px] font-semibold" style={{ background: DOOR.accent, color: DOOR.accentInk }}>
                  Get started
                </Link>
              </>
            )}
          </div>
        </div>
      </nav>
    );
  }
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
        <div className="flex items-center gap-2 sm:gap-2.5 shrink-0">
          {MARKETING_NAV_LINKS.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              // Changelog steps out below 1500px, so "Open app" always fits.
              className={`hidden ${href === "/changelog" ? "min-[1500px]:flex" : "md:flex"} items-center gap-1.5 font-medium text-sm px-2.5 py-1.5 transition-colors hover:text-[#002b36]`}
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
          {!mounted ? (
            <span aria-hidden className="block h-9 w-[7.5rem] shrink-0" />
          ) : signedIn ? (
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
