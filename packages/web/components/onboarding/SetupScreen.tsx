"use client";
// The frame every setup flow page shares (/start, Create team, Join team,
// team feature setup):
// full screen, no dashboard around it, the Codecast mark in the corner. There
// is no shell here, so the store's feeders and write wiring mount on their
// own: the account, teams, machines, and the dispatch that creates the team.
// A corner card that rose before the person got here (a theme intro, a
// feature offer) is hidden while the page is up and returns after; only
// plain toasts, the flow's own errors and confirmations, still show.
import type { ReactNode } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import "./onboarding.css";
import { AuthGuard } from "../AuthGuard";
import { ErrorBoundary } from "../ErrorBoundary";
import { DashboardSyncEffects } from "../DashboardLayout";
import { Logo } from "../Logo";

export function SetupScreen({ children }: { children: ReactNode }) {
  useMountEffect(() => {
    document.documentElement.classList.add("setup-screen");
    return () => document.documentElement.classList.remove("setup-screen");
  });
  return (
    <AuthGuard>
      <DashboardSyncEffects windowEffects={false} />
      <main className="min-h-screen overflow-x-hidden bg-sol-bg">
        <div className="px-5 pt-5 sm:px-8">
          <a href="/inbox" aria-label="Codecast home" className="inline-block">
            <Logo size="sm" className="text-sol-text-muted" />
          </a>
        </div>
        <div className="mx-auto max-w-4xl px-5 pt-[8vh] pb-16 sm:px-8">
          <ErrorBoundary name="SetupFlow" level="panel">
            {children}
          </ErrorBoundary>
        </div>
      </main>
    </AuthGuard>
  );
}
