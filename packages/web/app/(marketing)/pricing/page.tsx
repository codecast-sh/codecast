"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { usePageMeta } from "../pageMeta";

const PAGE_TITLE = "Pricing — Codecast";
const PAGE_DESCRIPTION =
  "Free forever for individuals. Team at $20/seat/month (early access). Enterprise on request. Bring your own agent subscriptions — codecast never resells or marks up model usage.";

function CheckIcon({ className, color }: { className?: string; color: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 20 20" style={{ color }}>
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
        clipRule="evenodd"
      />
    </svg>
  );
}

type Tier = {
  name: string;
  price: string;
  cadence?: string;
  badge?: string;
  tagline: string;
  featured?: boolean;
  featuresLead?: string;
  features: string[];
  accent: string;
  cta: { label: string; href: string; external?: boolean };
};

const TIERS: Tier[] = [
  {
    name: "Free",
    price: "$0",
    cadence: "free forever",
    tagline: "For individuals. Everything you need to watch, steer, and remember your own agents.",
    accent: "#268bd2",
    features: [
      "Unlimited agent sessions",
      "Every agent: Claude Code, Codex, Cursor, Gemini",
      "Full real-time sync across every device",
      "Web, desktop, and mobile apps",
      "Search and memory across your own sessions",
      "Self-host it yourself (MIT licensed)",
    ],
    cta: { label: "Get started free", href: "/signup" },
  },
  {
    name: "Team",
    price: "$20",
    cadence: "per seat / month",
    badge: "Early access",
    tagline: "Shared memory and a live inbox for everyone's agents. Waitlist now, no self-serve billing yet.",
    featured: true,
    accent: "#b58900",
    featuresLead: "Everything in Free, plus:",
    features: [
      "Shared team memory and search across members",
      "A live team feed of every session",
      "Share and message sessions across members",
      "cast blame across the whole team",
      "Admin controls",
      "Privacy controls — per-conversation visibility (full / summary / hidden)",
    ],
    cta: {
      label: "Request early access",
      href: "mailto:support@codecast.sh?subject=Codecast%20Team%20early%20access",
      external: true,
    },
  },
  {
    name: "Enterprise",
    price: "Contact",
    cadence: "custom",
    tagline: "For organizations that need identity, audit, and supported deployment.",
    accent: "#6c71c4",
    featuresLead: "Everything in Team, plus:",
    features: [
      "SSO and SCIM provisioning",
      "Audit log export",
      "Compliance review support",
      "Supported self-hosting",
    ],
    cta: {
      label: "Contact sales",
      href: "mailto:enterprise@codecast.sh?subject=Codecast%20Enterprise",
      external: true,
    },
  },
];

export default function PricingPage() {
  // Real page metadata in this SPA means writing document.title on mount; reuse the
  // blog surface's shared hook rather than duplicating the effect.
  usePageMeta(PAGE_TITLE, PAGE_DESCRIPTION);

  return (
    <main className="min-h-screen w-full overflow-x-hidden" style={{ backgroundColor: "#fdf6e3" }}>
      {/* Nav */}
      <nav
        className="backdrop-blur-sm sticky top-0 z-50"
        style={{ borderBottom: "1px solid #eee8d5", backgroundColor: "rgba(253,246,227,0.8)" }}
      >
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/">
            <Logo size="md" className="[--logo-c:#444444] text-[#002b36]" />
          </Link>
          <div className="flex items-center gap-3">
            <Link
              href="/documentation"
              className="font-medium text-sm px-3 py-1.5 hidden sm:block transition-colors"
              style={{ color: "#657b83" }}
            >
              Docs
            </Link>
            <Link
              href="/features"
              className="font-medium text-sm px-3 py-1.5 hidden sm:block transition-colors"
              style={{ color: "#657b83" }}
            >
              CLI
            </Link>
            <Link href="/pricing" className="font-medium text-sm px-3 py-1.5 hidden sm:block" style={{ color: "#b58900" }}>
              Pricing
            </Link>
            <Link
              href="/blog"
              className="font-medium text-sm px-3 py-1.5 hidden sm:block transition-colors"
              style={{ color: "#657b83" }}
            >
              Blog
            </Link>
            <Link
              href="/security"
              className="font-medium text-sm px-3 py-1.5 hidden sm:block transition-colors"
              style={{ color: "#657b83" }}
            >
              Security
            </Link>
            <Link href="/login">
              <Button variant="ghost" className="font-medium" style={{ color: "#657b83" }}>
                Sign in
              </Button>
            </Link>
            <Link href="/signup">
              <Button className="font-medium text-white" style={{ backgroundColor: "#002b36" }}>
                Get started
              </Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-6 pt-20 pb-8 text-center">
        <div
          className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-md mb-6"
          style={{ backgroundColor: "rgba(133,153,0,0.1)", color: "#859900" }}
        >
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: "#859900" }}></span>
          <span className="tracking-wider font-mono text-[11px] uppercase font-medium">Pricing</span>
        </div>
        <h1 className="text-5xl md:text-6xl font-bold leading-[1.1] tracking-tight mb-6 font-mono" style={{ color: "#002b36" }}>
          Honest pricing,<br />
          <span style={{ color: "#93a1a1" }}>free where it counts</span>
        </h1>
        <p className="text-xl leading-relaxed max-w-2xl mx-auto" style={{ color: "#657b83" }}>
          Free forever for individuals. A flat $20 per seat when your team is ready.
          We are pre-revenue and say so — no invented tiers, no lock-in.
        </p>
      </section>

      {/* Bring your own subscriptions — the differentiator, given weight */}
      <section className="max-w-4xl mx-auto px-6 pb-14">
        <div
          className="rounded-2xl p-8 md:p-10"
          style={{ backgroundColor: "#002b36", border: "1px solid #094959" }}
        >
          <div className="flex flex-col md:flex-row items-start gap-6">
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0"
              style={{ backgroundColor: "rgba(133,153,0,0.15)" }}
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="#859900">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <h2 className="text-2xl font-bold mb-2 font-mono" style={{ color: "#fdf6e3" }}>
                Bring your own agent subscriptions
              </h2>
              <p className="text-lg leading-relaxed" style={{ color: "#93a1a1" }}>
                Your Claude, OpenAI, and Gemini plans stay yours. Codecast never resells or marks up
                model usage — you pay your model providers directly, at their price. We charge for the
                shared memory and mission control on top, and nothing for the tokens underneath.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Tiers */}
      <section className="max-w-6xl mx-auto px-6 pb-20">
        <div className="grid md:grid-cols-3 gap-6 items-start">
          {TIERS.map((tier) => {
            const dark = tier.featured;
            const cardStyle = dark
              ? { backgroundColor: "#002b36", border: "2px solid #b58900" }
              : { backgroundColor: "#fdf6e3", border: "1px solid #eee8d5" };
            const headingColor = dark ? "#fdf6e3" : "#002b36";
            const bodyColor = dark ? "#93a1a1" : "#657b83";
            const featureColor = dark ? "#eee8d5" : "#586e75";
            return (
              <div key={tier.name} className="rounded-2xl p-7 h-full flex flex-col" style={cardStyle}>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xl font-semibold font-mono" style={{ color: headingColor }}>
                    {tier.name}
                  </h3>
                  {tier.badge && (
                    <span
                      className="tracking-wider font-mono text-[10px] uppercase font-medium px-2.5 py-1 rounded-md"
                      style={{ backgroundColor: "rgba(181,137,0,0.18)", color: "#b58900" }}
                    >
                      {tier.badge}
                    </span>
                  )}
                </div>

                <div className="flex items-baseline gap-2 mb-3">
                  <span className="text-4xl font-bold font-mono" style={{ color: headingColor }}>
                    {tier.price}
                  </span>
                  {tier.cadence && (
                    <span className="text-sm" style={{ color: bodyColor }}>
                      {tier.cadence}
                    </span>
                  )}
                </div>

                <p className="text-sm leading-relaxed mb-6" style={{ color: bodyColor }}>
                  {tier.tagline}
                </p>

                {tier.cta.external ? (
                  <a href={tier.cta.href}>
                    <Button
                      className="w-full font-medium mb-6"
                      style={
                        dark
                          ? { backgroundColor: "#fdf6e3", color: "#002b36" }
                          : { backgroundColor: "#002b36", color: "#fdf6e3" }
                      }
                    >
                      {tier.cta.label}
                    </Button>
                  </a>
                ) : (
                  <Link href={tier.cta.href}>
                    <Button
                      className="w-full font-medium mb-6"
                      style={
                        dark
                          ? { backgroundColor: "#fdf6e3", color: "#002b36" }
                          : { backgroundColor: "#002b36", color: "#fdf6e3" }
                      }
                    >
                      {tier.cta.label}
                    </Button>
                  </Link>
                )}

                {tier.featuresLead && (
                  <p className="text-xs font-medium uppercase tracking-wide mb-3" style={{ color: bodyColor }}>
                    {tier.featuresLead}
                  </p>
                )}
                <ul className="space-y-3">
                  {tier.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-3 text-sm" style={{ color: featureColor }}>
                      <CheckIcon className="w-5 h-5 shrink-0 mt-px" color={tier.accent} />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        <p className="text-center text-sm mt-8" style={{ color: "#93a1a1" }}>
          Prefer to run it all yourself? Codecast is MIT licensed and self-hostable — clone it,
          deploy it, own the whole stack.
        </p>
      </section>

      {/* CTA */}
      <section className="max-w-4xl mx-auto px-6 pb-20">
        <div className="rounded-2xl p-12 text-center" style={{ backgroundColor: "#eee8d5" }}>
          <h2 className="text-3xl font-bold mb-4 font-mono" style={{ color: "#002b36" }}>
            Start free today
          </h2>
          <p className="text-lg mb-8 max-w-xl mx-auto" style={{ color: "#657b83" }}>
            Install the CLI, connect your agents, and watch them from anywhere. Upgrade to Team
            when you want your whole team to share the memory.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/signup">
              <Button size="lg" className="text-white text-base px-8 h-12 font-medium" style={{ backgroundColor: "#002b36" }}>
                Get started free
              </Button>
            </Link>
            <a href="mailto:support@codecast.sh?subject=Codecast%20Team%20early%20access">
              <Button
                size="lg"
                variant="outline"
                className="bg-transparent text-base px-8 h-12 font-medium"
                style={{ borderColor: "#93a1a1", color: "#586e75" }}
              >
                Join the Team waitlist
              </Button>
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer style={{ borderTop: "1px solid #eee8d5", backgroundColor: "#fdf6e3" }}>
        <div className="max-w-6xl mx-auto px-6 py-12">
          <div className="grid md:grid-cols-4 gap-8">
            <div>
              <Logo size="md" className="[--logo-c:#444444] text-[#002b36] mb-4" />
              <p className="text-sm text-[#657b83]">
                See, steer, and remember every coding agent session — any agent, any machine.
              </p>
            </div>
            <div>
              <h4 className="font-semibold text-[#002b36] mb-3 text-sm">Product</h4>
              <ul className="space-y-2 text-sm text-[#657b83]">
                <li><Link href="/documentation" className="hover:text-[#073642]">Documentation</Link></li>
                <li><Link href="/features" className="hover:text-[#073642]">CLI</Link></li>
                <li><Link href="/changelog" className="hover:text-[#073642]">Changelog</Link></li>
                <li><Link href="/security" className="hover:text-[#073642]">Security</Link></li>
                <li><Link href="/pricing" className="hover:text-[#073642]">Pricing</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-[#002b36] mb-3 text-sm">Company</h4>
              <ul className="space-y-2 text-sm text-[#657b83]">
                <li><Link href="/about" className="hover:text-[#073642]">About</Link></li>
                <li><Link href="/blog" className="hover:text-[#073642]">Blog</Link></li>
                <li><Link href="/privacy" className="hover:text-[#073642]">Privacy</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-[#002b36] mb-3 text-sm">Connect</h4>
              <ul className="space-y-2 text-sm text-[#657b83]">
                <li><a href="https://github.com/codecast-sh" className="hover:text-[#073642]" target="_blank" rel="noopener noreferrer">GitHub</a></li>
                <li><a href="https://x.com/codecastsh" className="hover:text-[#073642]" target="_blank" rel="noopener noreferrer">Twitter</a></li>
                <li><a href="https://discord.gg/S7V5Wnfq" className="hover:text-[#073642]" target="_blank" rel="noopener noreferrer">Discord</a></li>
              </ul>
            </div>
          </div>
          <div className="border-t border-[#eee8d5] mt-8 pt-8 text-center text-sm text-[#839496]">
            &copy; 2026 Codecast
          </div>
        </div>
      </footer>
    </main>
  );
}
