"use client";

import { useState, type ComponentType } from "react";
import { useMountEffect } from "../../../../hooks/useMountEffect";
import { ORG_CSS, PAPER } from "./model";
import { Hero } from "./Hero";
import { Routing } from "./Routing";
import { Ladder } from "./Ladder";
import { Anatomy } from "./Anatomy";
import { Proposals } from "./Proposals";
import { Templates } from "./Templates";
import { Faces } from "./Faces";
import { Views } from "./Views";
import { Control } from "./Control";
import { Closing } from "./Closing";
import { Chapters } from "./Chapters";

const SECTIONS: [string, ComponentType][] = [
  ["hero", Hero], ["ladder", Ladder], ["views", Views], ["proposals", Proposals], ["anatomy", Anatomy],
  ["templates", Templates], ["faces", Faces], ["routing", Routing], ["control", Control], ["closing", Closing],
];

/**
 * /features/org. Each section renders its own <style>; the page-wide motion
 * classes (ORG_CSS) are set once here.
 */
export default function OrgPage() {
  // ?static renders every element at rest (no entrance motion), for captures.
  // ?only=<section> renders one section alone, so a capture of it starts at the top.
  const [still, setStill] = useState(false);
  const [only, setOnly] = useState<string | null>(null);
  useMountEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setStill(q.has("static"));
    setOnly(q.get("only"));
  });
  return (
    <main className="og-root" data-static={still ? "" : undefined} style={{ backgroundColor: PAPER }}>
      <style>{ORG_CSS}</style>
      {!only && <Chapters />}
      {SECTIONS.filter(([name]) => !only || name === only).map(([name, Section]) => <Section key={name} />)}
    </main>
  );
}
