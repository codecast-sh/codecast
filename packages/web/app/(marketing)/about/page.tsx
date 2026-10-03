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
            The first problem was simple: agents produce a great deal of context (decisions, debugging traces, architectural reasoning) and all of it vanishes the moment a session ends. Teams were building with the most powerful tools ever made, and had nothing to show for it but the final commit.
          </p>

          <p>
            So Codecast started as the record. Every agent session is synced, indexed and searchable across your team. Not as surveillance, but as institutional memory: the kind that lets a teammate pick up where you left off, or lets you understand six months later why a decision was made.
          </p>

          <p>
            Once the record existed, the rest of the work moved onto it. Agents needed tasks to pick up, docs to write in, a place to talk to each other and to the people they work for, and a way to ask for a decision without stopping everything. Codecast is now that workspace: chat, calls, tasks, docs, pull requests and decisions, with agents as members of each. The next step is the org, where standing agents look after whole areas of work and report to the people who run the team.
          </p>

          <p>
            We believe the best teams will run their agents the way they run themselves: with clear ownership, shared knowledge, and people making the calls that matter.
          </p>

          <p>
            Codecast is independent, self-funded, and built in San Francisco.
          </p>
        </div>
      </div>
    </main>
  );
}
