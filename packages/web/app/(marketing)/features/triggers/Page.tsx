"use client";

import { SOL } from "../../blog/blogChrome";
import { TRIGGER_CSS } from "./motion";
import { Hero } from "./Hero";
import { Clocks } from "./Clocks";
import { WhereRuns } from "./WhereRuns";
import { Precheck } from "./Precheck";
import { Report } from "./Report";
import { Unattended } from "./Unattended";
import { History } from "./History";
import { Workflow } from "./Workflow";
import { Recipes } from "./Recipes";
import { Cta, Limits, Reference, Related } from "./Closing";
import { useStillMode } from "../kit";

/**
 * /features/triggers. The page follows one night of triggers: the hero plays
 * it, each section then takes one part of what happened (how it fired, where it
 * ran, what it skipped, how it reported) and shows where you see it in the app.
 * `?static` renders every animation at its end state.
 */
export default function TriggersPage() {
  const still = useStillMode();
  return (
    <main className={`tg-root${still ? " tg-static" : ""}`} style={{ backgroundColor: SOL.base3 }}>
      <style>{TRIGGER_CSS}</style>
      <Hero />
      <Clocks />
      <WhereRuns />
      <Precheck />
      <Report />
      <Unattended />
      <History />
      <Workflow />
      <Recipes />
      <Reference />
      <Limits />
      <Related />
      <Cta />
    </main>
  );
}
