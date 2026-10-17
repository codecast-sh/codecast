"use client";

import { useStillMode } from "../kit";
import { MODS_CSS } from "./theme";
import { Hero } from "./Hero";
import { Depths, StaysTrue, Vocabulary, WrittenVsRead } from "./Sections";
import { Blocks, External, Learn, YourKinds } from "./Kinds";
import { Cta, Local, Reference, Related, Surfaces, Thread, Trust } from "./More";

/** /features/mods: the Mods deep dive. Still mode (`?static` or reduced motion) renders every animation at its end state. */
export default function ModsPage() {
  const still = useStillMode();
  return (
    <main className="md-root" data-static={still ? "" : undefined}>
      <style>{MODS_CSS}</style>
      <Hero />
      <WrittenVsRead />
      <StaysTrue />
      <Vocabulary />
      <Depths />
      <YourKinds />
      <External />
      <Blocks />
      <Learn />
      <Surfaces />
      <Thread />
      <Local />
      <Trust />
      <Reference />
      <Related />
      <Cta />
    </main>
  );
}
