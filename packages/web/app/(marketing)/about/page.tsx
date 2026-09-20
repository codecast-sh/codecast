import { useRouteMeta } from "../pageMeta";
import { MarketingNav } from "@/components/marketing/MarketingNav";

export default function AboutPage() {
  useRouteMeta("/about");
  return (
    <main className="min-h-screen w-full" style={{ backgroundColor: '#fdf6e3' }}>
      <MarketingNav active="/about" />

      <div className="max-w-3xl mx-auto px-6 py-20">
        <h1 className="text-4xl font-bold text-[#002b36] mb-8 tracking-tight" style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}>
          About Codecast
        </h1>

        <div className="space-y-6 text-[#586e75] text-lg leading-relaxed" style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}>
          <p>
            Codecast was built by an engineer who spent years watching the gap between what AI coding agents could do and what teams could actually learn from them.
          </p>

          <p>
            The problem was simple: AI agents generate enormous amounts of context -- decisions, debugging traces, architectural reasoning -- and all of it vanishes the moment a session ends. Teams were building with the most powerful tools ever created, and had nothing to show for it but the final commit.
          </p>

          <p>
            Codecast exists to capture that missing layer. Every agent session, every debugging rabbit hole, every architectural decision gets synced, indexed, and made searchable across your team. Not as surveillance, but as institutional memory -- the kind that lets a teammate pick up exactly where you left off, or lets your future self understand why a decision was made six months ago.
          </p>

          <p>
            We believe the best engineering teams will be the ones that compound their AI-assisted work into shared knowledge, rather than letting it evaporate session by session.
          </p>

          <p>
            Codecast is independent, self-funded, and built in San Francisco.
          </p>
        </div>
      </div>
    </main>
  );
}
