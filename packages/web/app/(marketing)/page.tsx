import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CopyInstallButton } from "@/components/copy-install-button";

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-[#f5f5f0] w-full">
      <nav className="border-b border-black/5 bg-[#f5f5f0]/80 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="font-serif text-xl font-semibold text-black">
            codecast
          </div>
          <div className="flex items-center gap-4">
            <Link href="/login">
              <Button variant="ghost" className="text-black hover:bg-black/5">
                Sign in
              </Button>
            </Link>
            <Link href="/signup">
              <Button className="bg-black text-white hover:bg-black/90">
                Get started
              </Button>
            </Link>
          </div>
        </div>
      </nav>

      <section className="max-w-6xl mx-auto px-6 pt-20 pb-16">
        <div className="max-w-3xl">
          <h1 className="font-serif text-6xl font-bold text-black leading-[1.1] mb-6">
            Share your AI coding sessions with your team
          </h1>
          <p className="text-xl text-black/70 leading-relaxed mb-8 font-sans">
            Codecast syncs Claude Code conversations automatically. See what
            your team built, learn from their approach, build on their progress.
          </p>

          <div className="bg-black/5 border border-black/10 rounded-lg p-6 mb-8 font-mono text-sm">
            <div className="flex items-start justify-between gap-4">
              <code className="text-black">
                curl -fsSL codecast.sh/install | sh
              </code>
              <CopyInstallButton />
            </div>
          </div>

          <div className="flex gap-3">
            <Link href="/signup">
              <Button
                size="lg"
                className="bg-black text-white hover:bg-black/90 text-base"
              >
                Start syncing
              </Button>
            </Link>
            <Link href="#features">
              <Button
                size="lg"
                variant="outline"
                className="border-black/20 text-black hover:bg-black/5"
              >
                Learn more
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-6 pb-20">
        <div className="bg-gradient-to-br from-black/5 to-black/10 rounded-2xl p-8 border border-black/10">
          <div className="bg-white rounded-lg shadow-2xl border border-black/10 overflow-hidden">
            <div className="bg-gradient-to-b from-black/5 to-transparent px-4 py-3 border-b border-black/10 flex items-center gap-2">
              <div className="flex gap-2">
                <div className="w-3 h-3 rounded-full bg-red-500/80"></div>
                <div className="w-3 h-3 rounded-full bg-yellow-500/80"></div>
                <div className="w-3 h-3 rounded-full bg-green-500/80"></div>
              </div>
              <div className="flex-1 text-center text-xs font-mono text-black/50">
                codecast - Conversation #1234
              </div>
            </div>
            <div className="p-8 bg-white min-h-[400px] flex items-center justify-center text-black/30 font-mono text-sm">
              [Screenshot placeholder - conversation view with turn-by-turn
              messages and tool calls]
            </div>
          </div>
        </div>
      </section>

      <section id="features" className="max-w-6xl mx-auto px-6 py-20">
        <h2 className="font-serif text-4xl font-bold text-black mb-12 text-center">
          Everything you need, nothing you don&apos;t
        </h2>

        <div className="grid md:grid-cols-3 gap-6">
          <Card className="bg-white border-black/10 p-6 hover:shadow-lg transition-shadow">
            <div className="w-12 h-12 rounded-full bg-black/5 flex items-center justify-center mb-4">
              <svg
                className="w-6 h-6 text-black"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
            </div>
            <h3 className="font-serif text-xl font-semibold text-black mb-2">
              Real-time sync
            </h3>
            <p className="text-black/70 leading-relaxed">
              Conversations sync automatically as you work. No manual exports,
              no copy-paste, no workflow disruption.
            </p>
          </Card>

          <Card className="bg-white border-black/10 p-6 hover:shadow-lg transition-shadow">
            <div className="w-12 h-12 rounded-full bg-black/5 flex items-center justify-center mb-4">
              <svg
                className="w-6 h-6 text-black"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
            </div>
            <h3 className="font-serif text-xl font-semibold text-black mb-2">
              Private by default
            </h3>
            <p className="text-black/70 leading-relaxed">
              Your code stays yours. Choose what to share, when to share it.
              Self-host if you want complete control.
            </p>
          </Card>

          <Card className="bg-white border-black/10 p-6 hover:shadow-lg transition-shadow">
            <div className="w-12 h-12 rounded-full bg-black/5 flex items-center justify-center mb-4">
              <svg
                className="w-6 h-6 text-black"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                />
              </svg>
            </div>
            <h3 className="font-serif text-xl font-semibold text-black mb-2">
              Team collaboration
            </h3>
            <p className="text-black/70 leading-relaxed">
              See what your teammates are building. Pick up where they left off.
              Learn from their debugging sessions.
            </p>
          </Card>

          <Card className="bg-white border-black/10 p-6 hover:shadow-lg transition-shadow">
            <div className="w-12 h-12 rounded-full bg-black/5 flex items-center justify-center mb-4">
              <svg
                className="w-6 h-6 text-black"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </div>
            <h3 className="font-serif text-xl font-semibold text-black mb-2">
              Search everything
            </h3>
            <p className="text-black/70 leading-relaxed">
              Find that API integration pattern from last week. Search across
              all team conversations, files, and tool calls.
            </p>
          </Card>

          <Card className="bg-white border-black/10 p-6 hover:shadow-lg transition-shadow">
            <div className="w-12 h-12 rounded-full bg-black/5 flex items-center justify-center mb-4">
              <svg
                className="w-6 h-6 text-black"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                />
              </svg>
            </div>
            <h3 className="font-serif text-xl font-semibold text-black mb-2">
              Analytics & insights
            </h3>
            <p className="text-black/70 leading-relaxed">
              Track which patterns work, which tools get used, where your team
              spends time. Data-driven development.
            </p>
          </Card>

          <Card className="bg-white border-black/10 p-6 hover:shadow-lg transition-shadow">
            <div className="w-12 h-12 rounded-full bg-black/5 flex items-center justify-center mb-4">
              <svg
                className="w-6 h-6 text-black"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
                />
              </svg>
            </div>
            <h3 className="font-serif text-xl font-semibold text-black mb-2">
              CLI-first
            </h3>
            <p className="text-black/70 leading-relaxed">
              Built for developers who live in the terminal. Lightweight daemon,
              zero configuration, works with your flow.
            </p>
          </Card>
        </div>
      </section>

      <section className="max-w-4xl mx-auto px-6 py-20">
        <Card className="bg-gradient-to-br from-white to-black/5 border-black/10 p-12 text-center">
          <h2 className="font-serif text-3xl font-bold text-black mb-4">
            Your code stays yours
          </h2>
          <p className="text-lg text-black/70 leading-relaxed mb-8 max-w-2xl mx-auto">
            Codecast never sees your code unless you explicitly share it. The
            CLI daemon runs locally, syncs only metadata by default, and gives
            you complete control over what gets shared.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center items-center text-sm text-black/60">
            <span className="flex items-center gap-2">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                  clipRule="evenodd"
                />
              </svg>
              Opt-in sharing
            </span>
            <span className="flex items-center gap-2">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                  clipRule="evenodd"
                />
              </svg>
              Self-hostable
            </span>
            <span className="flex items-center gap-2">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                  clipRule="evenodd"
                />
              </svg>
              Open source
            </span>
          </div>
        </Card>
      </section>

      <footer className="border-t border-black/10 bg-white/50">
        <div className="max-w-6xl mx-auto px-6 py-12">
          <div className="grid md:grid-cols-4 gap-8">
            <div>
              <div className="font-serif text-xl font-semibold text-black mb-4">
                codecast
              </div>
              <p className="text-sm text-black/60">
                Share AI coding sessions with your team
              </p>
            </div>
            <div>
              <h4 className="font-semibold text-black mb-3 text-sm">Product</h4>
              <ul className="space-y-2 text-sm text-black/70">
                <li>
                  <Link href="/features" className="hover:text-black">
                    Features
                  </Link>
                </li>
                <li>
                  <Link href="/pricing" className="hover:text-black">
                    Pricing
                  </Link>
                </li>
                <li>
                  <Link href="/docs" className="hover:text-black">
                    Documentation
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-black mb-3 text-sm">Company</h4>
              <ul className="space-y-2 text-sm text-black/70">
                <li>
                  <Link href="/about" className="hover:text-black">
                    About
                  </Link>
                </li>
                <li>
                  <Link href="/blog" className="hover:text-black">
                    Blog
                  </Link>
                </li>
                <li>
                  <Link href="/privacy" className="hover:text-black">
                    Privacy
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-black mb-3 text-sm">Connect</h4>
              <ul className="space-y-2 text-sm text-black/70">
                <li>
                  <a
                    href="https://github.com"
                    className="hover:text-black"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    GitHub
                  </a>
                </li>
                <li>
                  <a
                    href="https://twitter.com"
                    className="hover:text-black"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Twitter
                  </a>
                </li>
                <li>
                  <Link href="/discord" className="hover:text-black">
                    Discord
                  </Link>
                </li>
              </ul>
            </div>
          </div>
          <div className="border-t border-black/10 mt-8 pt-8 text-center text-sm text-black/50">
            &copy; 2025 Codecast. Built for developers, by developers.
          </div>
        </div>
      </footer>
    </main>
  );
}
