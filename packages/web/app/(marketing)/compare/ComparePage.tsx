"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BlogNav, BlogFooter, SOL } from "../blog/blogChrome";
import { useRouteMeta } from "../pageMeta";
import { COMPARISONS, getComparison, compareHref } from "./comparisons";

/**
 * Renders one /compare/<slug> page from the comparisons registry. One
 * component for every comparison, same pattern as GuidePage — content lives in
 * comparisons.ts, and this file owns only the presentation.
 */

function ChoiceList({ heading, items }: { heading: string; items: string[] }) {
  return (
    <div className="rounded-lg p-6" style={{ backgroundColor: SOL.base2 }}>
      <h3 className="font-mono font-semibold text-base mb-3" style={{ color: SOL.base03 }}>
        {heading}
      </h3>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item} className="text-sm leading-relaxed flex gap-2" style={{ color: SOL.base01 }}>
            <span aria-hidden style={{ color: SOL.base1 }}>—</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProsConsCard({ name, value }: { name: string; value: { pros: string[]; cons: string[] } }) {
  const list = (items: string[], color: string, mark: string) => (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item} className="text-sm leading-relaxed flex gap-2" style={{ color: SOL.base01 }}>
          <span aria-hidden className="font-mono font-bold shrink-0" style={{ color }}>{mark}</span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${SOL.base2}` }}>
      <div className="px-5 py-3 font-mono font-semibold text-sm" style={{ backgroundColor: SOL.base2, color: SOL.base03 }}>
        {name}
      </div>
      <div className="p-5 space-y-5">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest mb-2" style={{ color: SOL.green }}>Strengths</p>
          {list(value.pros, SOL.green, "+")}
        </div>
        <div>
          <p className="font-mono text-xs uppercase tracking-widest mb-2" style={{ color: SOL.red }}>Weaknesses</p>
          {list(value.cons, SOL.red, "\u2212")}
        </div>
      </div>
    </div>
  );
}

export default function ComparePage() {
  const params = useParams<{ slug: string }>();
  const comparison = getComparison(params.slug ?? "");
  useRouteMeta(comparison ? compareHref(comparison.slug) : "/compare");

  if (!comparison) {
    return (
      <main className="min-h-screen w-full" style={{ backgroundColor: SOL.base3 }}>
        <BlogNav />
        <div className="max-w-2xl mx-auto px-6 py-24 text-center">
          <h1 className="font-mono text-2xl font-bold mb-4" style={{ color: SOL.base03 }}>
            Comparison not found
          </h1>
          <Link href="/compare" className="text-sm underline" style={{ color: SOL.blue }}>
            All comparisons
          </Link>
        </div>
        <BlogFooter />
      </main>
    );
  }

  const c = comparison;
  return (
    <main className="min-h-screen w-full overflow-x-hidden" style={{ backgroundColor: SOL.base3 }}>
      <BlogNav />

      <article className="max-w-3xl mx-auto px-6 pt-16 pb-24">
        <p className="font-mono text-xs uppercase tracking-widest mb-4" style={{ color: SOL.base1 }}>
          <Link href="/compare" style={{ color: SOL.base1 }}>Comparisons</Link>
        </p>
        <h1 className="font-mono text-3xl sm:text-4xl font-bold leading-tight mb-4" style={{ color: SOL.base03 }}>
          {c.title}
        </h1>
        <p className="text-lg leading-relaxed mb-10" style={{ color: SOL.base00 }}>
          {c.dek}
        </p>

        <p className="leading-relaxed mb-4" style={{ color: SOL.base01 }}>{c.codecastIs}</p>
        <p className="leading-relaxed mb-10" style={{ color: SOL.base01 }}>
          {c.competitorIs}{" "}
          <a href={c.competitorUrl} rel="noopener" className="underline" style={{ color: SOL.blue }}>
            {c.competitor}&rsquo;s site
          </a>
          .
        </p>

        {c.bottomLine && (
          <div className="rounded-lg p-5 mb-12" style={{ backgroundColor: SOL.base2, borderLeft: `4px solid ${SOL.blue}` }}>
            <p className="font-mono text-xs uppercase tracking-widest mb-2" style={{ color: SOL.base1 }}>Bottom line</p>
            <p className="leading-relaxed" style={{ color: SOL.base02 }}>{c.bottomLine}</p>
          </div>
        )}

        <h2 className="font-mono text-xl font-bold mb-4" style={{ color: SOL.base03 }}>
          Side by side
        </h2>
        <div className="overflow-x-auto mb-12 rounded-lg" style={{ border: `1px solid ${SOL.base2}` }}>
          <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ backgroundColor: SOL.base2 }}>
                <th className="text-left font-mono font-semibold p-3" style={{ color: SOL.base03 }} />
                <th className="text-left font-mono font-semibold p-3" style={{ color: SOL.base03 }}>Codecast</th>
                <th className="text-left font-mono font-semibold p-3" style={{ color: SOL.base03 }}>{c.competitor}</th>
              </tr>
            </thead>
            <tbody>
              {c.rows.map((row, i) => (
                <tr key={row.dimension} style={{ borderTop: i > 0 ? `1px solid ${SOL.base2}` : undefined }}>
                  <td className="p-3 font-mono font-medium align-top whitespace-nowrap" style={{ color: SOL.base01 }}>
                    {row.dimension}
                  </td>
                  <td className="p-3 align-top leading-relaxed" style={{ color: SOL.base00 }}>{row.codecast}</td>
                  <td className="p-3 align-top leading-relaxed" style={{ color: SOL.base00 }}>{row.competitor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {c.strengths && (
          <>
            <h2 className="font-mono text-xl font-bold mb-4" style={{ color: SOL.base03 }}>
              Strengths and weaknesses
            </h2>
            <div className="grid sm:grid-cols-2 gap-6 mb-12">
              <ProsConsCard name="Codecast" value={c.strengths.codecast} />
              <ProsConsCard name={c.competitor} value={c.strengths.competitor} />
            </div>
          </>
        )}

        {c.deepDives?.map((section) => (
          <section key={section.heading} className="mb-10">
            <h2 className="font-mono text-xl font-bold mb-3" style={{ color: SOL.base03 }}>
              {section.heading}
            </h2>
            {section.paragraphs.map((para) => (
              <p key={para} className="leading-relaxed mb-3" style={{ color: SOL.base01 }}>{para}</p>
            ))}
          </section>
        ))}

        <div className="grid sm:grid-cols-2 gap-6 mb-12">
          <ChoiceList heading={`Choose ${c.competitor} when`} items={c.whenCompetitor} />
          <ChoiceList heading="Choose Codecast when" items={c.whenCodecast} />
        </div>

        {c.together && (
          <p className="leading-relaxed mb-12 rounded-lg p-5" style={{ color: SOL.base01, border: `1px solid ${SOL.base2}` }}>
            {c.together}
          </p>
        )}

        {c.verifiedOn && (
          <p className="font-mono text-xs mb-12" style={{ color: SOL.base1 }}>
            {c.competitor} facts read from its public docs on {c.verifiedOn}. Tell us if something changed.
          </p>
        )}

        <div className="text-center rounded-lg p-8" style={{ backgroundColor: SOL.base2 }}>
          <p className="font-mono font-semibold mb-4" style={{ color: SOL.base03 }}>
            Try codecast on the sessions you ran today
          </p>
          <div className="flex gap-3 justify-center">
            <Link href="/signup">
              <Button className="text-white text-sm px-6 h-10 font-medium" style={{ backgroundColor: SOL.base03 }}>
                Get started free
              </Button>
            </Link>
            <Link href="/documentation">
              <Button variant="outline" className="bg-transparent text-sm px-6 h-10 font-medium" style={{ borderColor: SOL.base1, color: SOL.base01 }}>
                Read the docs
              </Button>
            </Link>
          </div>
        </div>

        <div className="mt-12">
          <h2 className="font-mono text-base font-bold mb-3" style={{ color: SOL.base03 }}>
            More comparisons
          </h2>
          <ul className="space-y-1">
            {COMPARISONS.filter((other) => other.slug !== c.slug).map((other) => (
              <li key={other.slug}>
                <Link href={compareHref(other.slug)} className="text-sm underline" style={{ color: SOL.blue }}>
                  {other.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </article>

      <BlogFooter />
    </main>
  );
}
