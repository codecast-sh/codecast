"use client";
// A new person's first run: one flow that makes their team, turns on every
// feature, connects their machine with every agent feature, and invites the
// team (components/onboarding/SetupFlow). Signup lands here; an inbox on its
// first run with no team sends the person here once.
import { SetupScreen } from "../../components/onboarding/SetupScreen";
import { SetupFlow } from "../../components/onboarding/SetupFlow";

export default function StartPage() {
  return (
    <SetupScreen>
      <SetupFlow mode="welcome" />
    </SetupScreen>
  );
}
