"use client";

import { BlogNav, SOL } from "../blog/blogChrome";
import { useRouteMeta } from "../pageMeta";
import { ComparisonList } from "./ComparisonList";

export default function CompareIndexPage() {
  useRouteMeta("/compare");

  return (
    <main className="min-h-screen w-full overflow-x-hidden" style={{ backgroundColor: SOL.base3 }}>
      <BlogNav />

      <div className="max-w-3xl mx-auto px-6 pt-16 pb-24">
        <h1 className="font-mono text-3xl sm:text-4xl font-bold leading-tight mb-4" style={{ color: SOL.base03 }}>
          Codecast vs the alternatives
        </h1>
        <p className="text-lg leading-relaxed mb-12" style={{ color: SOL.base00 }}>
          Honest side-by-side comparisons with other coding agent tools — what each is
          actually for, and when the other one is the better choice.
        </p>

        <ComparisonList />
      </div>
    </main>
  );
}
