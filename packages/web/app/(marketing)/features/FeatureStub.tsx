"use client";

import { getFeatureDeepDive } from "./catalog";
import { SOL } from "../blog/blogChrome";

/** Placeholder body for a deep dive whose page has not been written yet. */
export function FeatureStub({ slug }: { slug: string }) {
  const f = getFeatureDeepDive(slug);
  return (
    <section className="max-w-3xl mx-auto px-6 py-24">
      <h1 className="font-mono text-3xl font-bold mb-4" style={{ color: SOL.base03 }}>{f?.title}</h1>
      <p className="text-lg" style={{ color: SOL.base00 }}>{f?.dek}</p>
    </section>
  );
}
