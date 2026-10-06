"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useRouteMeta } from "../pageMeta";
import { earlyAccessMailto } from "@/lib/siteLinks";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { ComparisonList } from "../compare/ComparisonList";
import { PLANS } from "@codecast/shared/contracts/assistant";
import { planPoints, planPrice } from "@/components/simple/planWords";
import { useUpgradesOpen } from "@/components/simple/billing";

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
      href: earlyAccessMailto("Team"),
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
  useRouteMeta("/pricing");
  const upgradesOpen = useUpgradesOpen();

  return (
    <main className="min-h-screen w-full overflow-x-hidden" style={{ backgroundColor: "#fdf6e3" }}>
      <MarketingNav active="/pricing" />

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

      {/* The Codecast assistant: the hosted plans for people who do not
          write code. Every figure and word comes from the PLANS catalog
          through the same plan words Settings > Plan shows. */}
      <section id="assistant" className="max-w-6xl mx-auto px-6 pb-20">
        <div className="text-center max-w-2xl mx-auto mb-10">
          <h2 className="text-3xl font-bold mb-3 font-mono" style={{ color: "#002b36" }}>
            The Codecast assistant
          </h2>
          <p className="text-lg leading-relaxed" style={{ color: "#657b83" }}>
            For everyone, nothing to install. It runs your errands, notes and routines, and your mail
            through Whisk, asking before anything goes out. We run the AI, so a plan covers it all.
          </p>
        </div>
        <div className="grid md:grid-cols-3 gap-6 items-start">
          {Object.values(PLANS).map((plan) => (
            <div key={plan.id} className="rounded-2xl p-7 h-full flex flex-col" style={{ backgroundColor: "#fdf6e3", border: "1px solid #eee8d5" }}>
              <div className="flex items-center justify-between gap-2 mb-3">
                <h3 className="text-xl font-semibold font-mono" style={{ color: "#002b36" }}>{plan.label}</h3>
                {/* A paid plan says so while it cannot be bought yet, as the
                    app's Plan settings do (useUpgradesOpen). */}
                {plan.price_usd > 0 && !upgradesOpen ? (
                  <span className="rounded-full px-2.5 py-0.5 text-xs font-medium" style={{ backgroundColor: "#eee8d5", color: "#586e75" }}>Coming soon</span>
                ) : null}
              </div>
              <div className="flex items-baseline gap-2 mb-6">
                <span className="text-4xl font-bold font-mono" style={{ color: "#002b36" }}>{planPrice(plan).replace(/ a month$/, "")}</span>
                <span className="text-sm" style={{ color: "#657b83" }}>a month</span>
              </div>
              <ul className="space-y-3 flex-1">
                {planPoints(plan).map((point) => (
                  <li key={point} className="flex items-start gap-3 text-sm" style={{ color: "#586e75" }}>
                    <CheckIcon className="w-5 h-5 shrink-0 mt-px" color="#cb4b16" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="flex justify-center mt-8">
          <Link href="/welcome">
            <Button className="text-[15px] px-6 h-11 font-semibold text-[#fdf6e3] border-0" style={{ background: "#cb4b16" }}>
              Get started with the assistant
            </Button>
          </Link>
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-4xl mx-auto px-6 pb-20">
        <div className="rounded-2xl p-12 text-center" style={{ backgroundColor: "#eee8d5" }}>
          <h2 className="text-3xl font-bold mb-4 font-mono" style={{ color: "#002b36" }}>
            Start free today
          </h2>
          <p className="text-lg mb-8 max-w-xl mx-auto" style={{ color: "#657b83" }}>
            Write code? Install the CLI, connect your agents, and watch them from anywhere. Don&apos;t?
            Start with the assistant, nothing to install.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/signup">
              <Button size="lg" className="text-white text-base px-8 h-12 font-medium" style={{ backgroundColor: "#002b36" }}>
                Get started free
              </Button>
            </Link>
            <Link href="/welcome">
              <Button size="lg" className="text-base px-8 h-12 font-medium text-[#fdf6e3]" style={{ backgroundColor: "#cb4b16" }}>
                Start with the assistant
              </Button>
            </Link>
            <a href={earlyAccessMailto("Team")}>
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

      <section className="max-w-3xl mx-auto px-6 pb-24">
        <h2 className="font-mono text-2xl font-bold mb-3" style={{ color: "#002b36" }}>
          Comparing tools?
        </h2>
        <p className="leading-relaxed mb-8" style={{ color: "#586e75" }}>
          Side by side comparisons with other coding agent tools, including when the other one is the better choice.
        </p>
        <ComparisonList />
      </section>
    </main>
  );
}
