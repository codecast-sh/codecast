"use client";
// /trial: a trial project's cards (components/trial/TrialReviewPage.tsx). The
// tab shell routes /trial here too (components/RoutePane.tsx); this file
// gives a direct load the same page.
import { AuthGuard } from "../../components/AuthGuard";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { TrialReviewPage } from "../../components/trial/TrialReviewPage";

export default function TrialPage() {
  return (
    <AuthGuard>
      <ErrorBoundary name="Trial">
        <TrialReviewPage />
      </ErrorBoundary>
    </AuthGuard>
  );
}
