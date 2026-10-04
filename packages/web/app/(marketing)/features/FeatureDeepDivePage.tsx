"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { useRouteMeta } from "../pageMeta";
import { SOL } from "../blog/blogChrome";
import { featureHref, getFeatureDeepDive } from "./catalog";
import { FEATURE_PAGES } from "./pages";

/**
 * /features/<slug>: the shared shell (meta, nav) around one deep dive; the
 * marketing layout adds the footer.
 * The body is the page's own component, so each feature can look like itself.
 */
export default function FeatureDeepDivePage() {
  const slug = useParams<{ slug: string }>().slug ?? "";
  const feature = getFeatureDeepDive(slug);
  useRouteMeta(feature ? featureHref(feature.slug) : "/features");
  const Body = FEATURE_PAGES[slug];
  return (
    <div className="min-h-screen w-full overflow-x-hidden">
      <MarketingNav active="/features" />
      {feature && Body ? (
        <Body />
      ) : (
        <main className="max-w-2xl mx-auto px-6 py-24 text-center" style={{ backgroundColor: SOL.base3 }}>
          <h1 className="font-mono text-2xl font-bold mb-4" style={{ color: SOL.base03 }}>Feature not found</h1>
          <Link href="/features" className="text-sm underline" style={{ color: SOL.blue }}>All features</Link>
        </main>
      )}
    </div>
  );
}
